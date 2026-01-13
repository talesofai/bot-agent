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

    const channel = await this.client.channels.fetch(session.channelId);
    if (!channel || !channel.isTextBased()) {
      throw new Error("channelId is not a text channel.");
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

  for (const element of elements) {
    if (element.type === "text") {
      textParts.push(element.text);
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

  const resolvedContent = textParts.join("").trim() || content.trim();
  const payload: MessageCreateOptions = {};
  if (resolvedContent) {
    payload.content = resolvedContent;
  }
  if (embeds.length > 0) {
    payload.embeds = embeds;
  }
  return payload;
}
