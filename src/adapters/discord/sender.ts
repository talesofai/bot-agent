import type { Logger } from "pino";
import type {
  SendMessageOptions,
  SessionElement,
  SessionEvent,
} from "../../types/platform";
import { Client, type MessageCreateOptions } from "discord.js";
import { resolveDiscordImageAttachments } from "./image-attachments";
import { getTraceIdFromExtras } from "../../telemetry";
import { BotMessageStore } from "../../store/bot-message-store";
import { feishuLogJson } from "../../feishu/webhook";
import { redactSensitiveText } from "../../utils/redact";

export class MessageSender {
  private client: Client;
  private logger: Logger;
  private botMessageStore?: BotMessageStore;

  constructor(
    client: Client,
    logger: Logger,
    botMessageStore?: BotMessageStore,
  ) {
    this.client = client;
    this.logger = logger.child({ component: "sender" });
    this.botMessageStore = botMessageStore;
  }

  async send(
    session: SessionEvent,
    content: string,
    options?: SendMessageOptions,
  ): Promise<void> {
    const traceId = getTraceIdFromExtras(session.extras);
    const log = traceId ? this.logger.child({ traceId }) : this.logger;
    if (!session.channelId) {
      throw new Error("channelId is required for sending messages.");
    }

    const channel = await this.resolveChannel(session.channelId);
    if (!isSendableChannel(channel)) {
      log.warn({ channelId: session.channelId }, "Channel is not sendable");
      return;
    }

    const { elements, files } = await resolveDiscordImageAttachments(
      options?.elements ?? [],
      { logger: log },
    );

    const resolvedReply = resolveReplyTarget(session, elements);
    const payload = buildPayload(content, resolvedReply.elements);
    if (files.length > 0) {
      payload.files = files;
    }
    if (resolvedReply.replyTo) {
      payload.reply = {
        messageReference: resolvedReply.replyTo,
        failIfNotExists: false,
      };
    }
    if (
      !payload.content &&
      (!payload.embeds || payload.embeds.length === 0) &&
      (!payload.files || payload.files.length === 0)
    ) {
      return;
    }

    const replySignature =
      resolvedReply.replyTo && payload.content?.trim()
        ? BotMessageStore.hashSignature(payload.content)
        : "";
    if (resolvedReply.replyTo && replySignature && this.botMessageStore) {
      const alreadySent = await this.botMessageStore.hasReplySignature({
        platform: session.platform,
        selfId: session.selfId,
        replyTo: resolvedReply.replyTo,
        signature: replySignature,
      });
      if (alreadySent) {
        log.debug(
          { replyTo: resolvedReply.replyTo, signature: replySignature },
          "Skipping duplicate reply",
        );
        return;
      }
    }

    try {
      const sent = await channel.send(payload);
      const messageId =
        sent && typeof sent === "object" && "id" in sent ? String(sent.id) : "";
      if (messageId && session.selfId) {
        await this.botMessageStore?.recordSentMessage({
          platform: session.platform,
          selfId: session.selfId,
          messageId,
        });
        if (resolvedReply.replyTo && replySignature) {
          await this.botMessageStore?.recordReplySignature({
            platform: session.platform,
            selfId: session.selfId,
            replyTo: resolvedReply.replyTo,
            signature: replySignature,
          });
        }
      }
      feishuLogJson({
        event: "io.send",
        platform: session.platform,
        traceId: traceId ?? undefined,
        channelId: session.channelId,
        botId: session.selfId ?? undefined,
        messageId,
        contentPreview: previewTextForLog(payload.content ?? "", 1200),
        contentLength: payload.content?.length ?? 0,
        hasFiles: Boolean(payload.files && payload.files.length > 0),
        hasEmbeds: Boolean(payload.embeds && payload.embeds.length > 0),
      });
      log.debug({ channelId: session.channelId }, "Message sent");
    } catch (err) {
      log.error({ err, channelId: session.channelId }, "Send failed");
      throw err;
    }
  }

  async sendTyping(session: SessionEvent): Promise<void> {
    const traceId = getTraceIdFromExtras(session.extras);
    const log = traceId ? this.logger.child({ traceId }) : this.logger;
    if (!session.channelId) {
      throw new Error("channelId is required for sending messages.");
    }

    const channel = await this.resolveChannel(session.channelId);
    if (!isTypableChannel(channel)) {
      return;
    }

    try {
      await channel.sendTyping();
      log.debug({ channelId: session.channelId }, "Typing sent");
    } catch (err) {
      log.debug(
        { err, channelId: session.channelId },
        "Failed to send typing indicator",
      );
    }
  }

  private async resolveChannel(
    channelId: string,
  ): Promise<unknown | null | undefined> {
    const cached = this.client.channels.cache.get(channelId);
    if (cached) {
      return cached;
    }
    try {
      return await this.client.channels.fetch(channelId);
    } catch (err) {
      this.logger.warn(
        { err, channelId },
        "Failed to fetch channel for sending",
      );
      return null;
    }
  }
}

function buildPayload(
  content: string,
  elements: ReadonlyArray<SessionElement>,
): MessageCreateOptions {
  if (elements.length === 0) {
    return { content };
  }

  const textParts: string[] = [];
  const imageUrls: string[] = [];
  let hasTextElement = false;

  for (const element of elements) {
    if (element.type === "text") {
      textParts.push(element.text);
      hasTextElement = true;
      continue;
    }
    if (element.type === "mention") {
      textParts.push(`<@${element.userId}>`);
      continue;
    }
    if (element.type === "image") {
      imageUrls.push(element.url);
      continue;
    }
  }

  const normalizedContent = content.trim();
  const baseContent = textParts.join("").trim();
  const resolvedImageUrls = imageUrls.filter((url, index) => {
    if (imageUrls.indexOf(url) !== index) {
      return false;
    }
    if (baseContent.includes(url)) {
      return false;
    }
    if (normalizedContent.includes(url)) {
      return false;
    }
    return true;
  });
  const resolvedContentParts: string[] = [];
  if (baseContent) {
    resolvedContentParts.push(baseContent);
  }
  if (!hasTextElement && normalizedContent) {
    resolvedContentParts.push(normalizedContent);
  }
  if (resolvedImageUrls.length > 0) {
    resolvedContentParts.push(resolvedImageUrls.join("\n"));
  }
  const resolvedContent = resolvedContentParts.join("\n\n").trim();
  const payload: MessageCreateOptions = {};
  if (resolvedContent) {
    payload.content = resolvedContent;
  }
  return payload;
}

function isSendableChannel(
  channel: unknown,
): channel is { send: (options: MessageCreateOptions) => Promise<unknown> } {
  if (!channel || typeof channel !== "object") {
    return false;
  }
  if (!("send" in channel)) {
    return false;
  }
  const candidate = channel as { send?: unknown };
  return typeof candidate.send === "function";
}

function isTypableChannel(
  channel: unknown,
): channel is { sendTyping: () => Promise<unknown> } {
  if (!channel || typeof channel !== "object") {
    return false;
  }
  if (!("sendTyping" in channel)) {
    return false;
  }
  const candidate = channel as { sendTyping?: unknown };
  return typeof candidate.sendTyping === "function";
}

function resolveReplyTarget(
  session: SessionEvent,
  elements: ReadonlyArray<SessionElement>,
): { replyTo: string | null; elements: SessionElement[] } {
  let replyTo: string | null = null;
  const cleanedElements: SessionElement[] = [];
  for (const element of elements) {
    if (element.type === "quote") {
      const candidate = element.messageId?.trim();
      if (candidate && isLikelyDiscordMessageId(candidate)) {
        replyTo = candidate;
      }
      continue;
    }
    cleanedElements.push(element);
  }

  if (!replyTo) {
    const fallback = session.messageId?.trim();
    if (
      fallback &&
      isLikelyDiscordMessageId(fallback) &&
      !isDiscordInteractionEvent(session.extras) &&
      !isScheduledPushEvent(session.extras)
    ) {
      replyTo = fallback;
    }
  }

  return { replyTo, elements: cleanedElements };
}

function isLikelyDiscordMessageId(value: string): boolean {
  return /^\d{16,20}$/.test(value);
}

function isDiscordInteractionEvent(extras: unknown): boolean {
  if (!extras || typeof extras !== "object") {
    return false;
  }
  const record = extras as Record<string, unknown>;
  const interactionId = record["interactionId"];
  return typeof interactionId === "string" && interactionId.trim().length > 0;
}

function isScheduledPushEvent(extras: unknown): boolean {
  if (!extras || typeof extras !== "object") {
    return false;
  }
  const record = extras as Record<string, unknown>;
  return record["isScheduledPush"] === true;
}

function previewTextForLog(text: string, maxBytes: number): string {
  const trimmed = redactSensitiveText(String(text ?? "")).trim();
  if (!trimmed) {
    return "";
  }
  if (maxBytes <= 0) {
    return "";
  }
  const buffer = Buffer.from(trimmed, "utf8");
  if (buffer.byteLength <= maxBytes) {
    return trimmed;
  }
  const sliced = buffer.toString("utf8", 0, maxBytes);
  return `${sliced}\n\n[truncated]`;
}
