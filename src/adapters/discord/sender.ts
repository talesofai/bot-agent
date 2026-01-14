import type { Logger } from "pino";
import type {
  SendMessageOptions,
  SessionElement,
  SessionEvent,
} from "../../types/platform";
import { Client, EmbedBuilder, type MessageCreateOptions } from "discord.js";

export class MessageSender {
  private client: Client;
  private logger: Logger;

  constructor(client: Client, logger: Logger) {
    this.client = client;
    this.logger = logger.child({ component: "sender" });
  }

  async send(
    session: SessionEvent,
    content: string,
    options?: SendMessageOptions,
  ): Promise<void> {
    if (!session.channelId) {
      throw new Error("channelId is required for sending messages.");
    }

    const channel = await this.resolveChannel(session.channelId);
    if (!isSendableChannel(channel)) {
      this.logger.warn(
        { channelId: session.channelId },
        "Channel is not sendable",
      );
      return;
    }

    const payload = buildPayload(content, options?.elements ?? []);
    if (!payload.content && (!payload.embeds || payload.embeds.length === 0)) {
      return;
    }

    try {
      await channel.send(payload);
      this.logger.debug({ channelId: session.channelId }, "Message sent");
    } catch (err) {
      this.logger.error({ err, channelId: session.channelId }, "Send failed");
      throw err;
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
  elements: SessionElement[],
): MessageCreateOptions {
  if (elements.length === 0) {
    return { content };
  }

  const textParts: string[] = [];
  const embeds: EmbedBuilder[] = [];
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
      const embed = new EmbedBuilder().setImage(element.url);
      embeds.push(embed);
      continue;
    }
    if (element.type === "quote") {
      textParts.push(`[quote:${element.messageId}]`);
    }
  }

  const normalizedContent = content.trim();
  const baseContent = textParts.join("").trim();
  const resolvedContent = hasTextElement
    ? baseContent
    : [baseContent, normalizedContent].filter(Boolean).join(" ");
  const payload: MessageCreateOptions = {};
  if (resolvedContent) {
    payload.content = resolvedContent;
  }
  if (embeds.length > 0) {
    payload.embeds = embeds;
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
