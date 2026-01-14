import type { Message } from "discord.js";
import type { SessionElement, SessionEvent } from "../../types/platform";
import {
  appendTextElement,
  extractTextFromElements,
  trimTextElements,
} from "../utils";

export interface DiscordMessageExtras {
  messageId: string;
  channelId: string;
  guildId?: string;
  authorId: string;
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
    },
  };
}

function buildElements(rawContent: string, message: Message): SessionElement[] {
  const elements: SessionElement[] = [];
  const mentionIds = new Set(message.mentions.users.keys());
  if (rawContent) {
    const pattern = /<@!?(\d+)>/g;
    let lastIndex = 0;
    for (const match of rawContent.matchAll(pattern)) {
      const start = match.index ?? 0;
      if (start > lastIndex) {
        appendTextElement(elements, rawContent.slice(lastIndex, start));
      }
      const userId = match[1];
      if (userId && mentionIds.has(userId)) {
        elements.push({ type: "mention", userId });
      } else {
        appendTextElement(elements, match[0]);
      }
      lastIndex = start + match[0].length;
    }
    if (lastIndex < rawContent.length) {
      appendTextElement(elements, rawContent.slice(lastIndex));
    }
  }
  for (const attachment of message.attachments.values()) {
    if (attachment.url) {
      elements.push({ type: "image", url: attachment.url });
    }
  }

  return trimTextElements(elements);
}
