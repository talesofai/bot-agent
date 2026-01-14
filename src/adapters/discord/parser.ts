import type { Message } from "discord.js";
import type { SessionElement, SessionEvent } from "../../types/platform";
import { extractTextFromElements, trimTextElements } from "../utils";

export interface DiscordMessageExtras {
  messageId: string;
  channelId: string;
  guildId?: string;
  authorId: string;
  mentionUserIds: string[];
}

export function parseMessage(
  message: Message,
  selfId?: string,
): SessionEvent<DiscordMessageExtras> | null {
  if (message.author.bot) {
    return null;
  }
  const botId = selfId ?? message.client.user?.id ?? "";
  if (botId && message.author.id === botId) {
    return null;
  }

  const rawContent = message.content ?? "";
  const elements = buildElements(rawContent, message);
  const content = extractTextFromElements(elements);

  return {
    type: "message",
    platform: "discord",
    selfId: botId,
    userId: message.author.id,
    guildId: message.guildId ?? undefined,
    channelId: message.channelId,
    messageId: message.id,
    content,
    elements,
    timestamp: message.createdTimestamp,
    extras: {
      messageId: message.id,
      channelId: message.channelId,
      guildId: message.guildId ?? undefined,
      authorId: message.author.id,
      mentionUserIds: Array.from(message.mentions.users.keys()),
    },
  };
}

function buildElements(rawContent: string, message: Message): SessionElement[] {
  const elements: SessionElement[] = [];
  if (rawContent) {
    elements.push({ type: "text", text: rawContent });
  }
  for (const attachment of message.attachments.values()) {
    if (attachment.url) {
      elements.push({ type: "image", url: attachment.url });
    }
  }

  return trimTextElements(elements);
}
