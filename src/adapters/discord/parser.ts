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
  const mentionUserIds = new Set(message.mentions.users.keys());

  elements.push(...splitContent(rawContent, mentionUserIds));
  for (const attachment of message.attachments.values()) {
    if (attachment.url) {
      elements.push({ type: "image", url: attachment.url });
    }
  }

  return trimTextElements(elements);
}

function splitContent(
  content: string,
  mentionUserIds: Set<string>,
): SessionElement[] {
  if (!content) {
    return [];
  }
  const elements: SessionElement[] = [];
  const mentionPattern = /<@!?(\d+)>/g;
  let cursor = 0;
  let match = mentionPattern.exec(content);
  while (match) {
    const index = match.index;
    const mentionId = match[1];
    const mentionEnd = index + match[0].length;
    if (!mentionUserIds.has(mentionId)) {
      const text = content.slice(cursor, mentionEnd);
      if (text) {
        elements.push({ type: "text", text });
      }
      cursor = mentionEnd;
      match = mentionPattern.exec(content);
      continue;
    }
    if (index > cursor) {
      const text = content.slice(cursor, index);
      if (text) {
        elements.push({ type: "text", text });
      }
    }
    elements.push({ type: "mention", userId: mentionId });
    cursor = mentionEnd;
    match = mentionPattern.exec(content);
  }
  if (cursor < content.length) {
    const text = content.slice(cursor);
    if (text) {
      elements.push({ type: "text", text });
    }
  }
  return elements;
}
