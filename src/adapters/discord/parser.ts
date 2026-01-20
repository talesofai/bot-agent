import { PermissionFlagsBits, type Message } from "discord.js";
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
  isGuildOwner?: boolean;
  isGuildAdmin?: boolean;
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
  const elements = buildElements(rawContent, message, botId);
  const content = extractTextFromElements(elements);

  const isGuildOwner = Boolean(
    message.guild && message.guild.ownerId === message.author.id,
  );
  const isGuildAdmin = Boolean(
    message.member?.permissions?.has(PermissionFlagsBits.Administrator) ||
    message.member?.permissions?.has(PermissionFlagsBits.ManageGuild),
  );

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
      isGuildOwner: message.guildId ? isGuildOwner : undefined,
      isGuildAdmin: message.guildId ? isGuildAdmin : undefined,
    },
  };
}

function buildElements(
  rawContent: string,
  message: Message,
  botId: string,
): SessionElement[] {
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

  const repliedUserId = message.mentions.repliedUser?.id;
  if (
    botId &&
    repliedUserId === botId &&
    !elements.some(
      (element) => element.type === "mention" && element.userId === botId,
    )
  ) {
    elements.unshift({ type: "mention", userId: botId });
  }

  if (
    botId &&
    message.mentions.users.has(botId) &&
    !elements.some(
      (element) => element.type === "mention" && element.userId === botId,
    )
  ) {
    elements.unshift({ type: "mention", userId: botId });
  }

  return trimTextElements(elements);
}
