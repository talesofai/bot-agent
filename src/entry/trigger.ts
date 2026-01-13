import type { GroupConfig } from "../types/group";
import type { SessionEvent } from "../types";

export interface KeywordMatch {
  global: boolean;
  group: boolean;
  bot: Set<string>;
}

export interface TriggerInput {
  groupConfig: GroupConfig;
  message: SessionEvent;
  keywordMatch: KeywordMatch;
}

export function shouldEnqueue(input: TriggerInput): boolean {
  const { groupConfig, message, keywordMatch } = input;
  if (mentionsSelf(message)) {
    return true;
  }
  if (groupConfig.triggerMode === "mention") {
    return false;
  }
  if (keywordMatch.global || keywordMatch.group) {
    return true;
  }
  if (keywordMatch.bot.size === 0) {
    return false;
  }
  const selfId = message.selfId ?? "";
  return keywordMatch.bot.has(selfId);
}

function mentionsSelf(message: SessionEvent): boolean {
  if (!message.selfId) {
    return false;
  }
  return (
    message.elements.some(
      (element) =>
        element.type === "mention" && element.userId === message.selfId,
    ) || mentionsSelfInContent(message)
  );
}

export function matchesKeywords(content: string, keywords: string[]): boolean {
  if (keywords.length === 0) {
    return false;
  }
  const lowered = content.toLowerCase();
  return keywords.some((keyword) => lowered.includes(keyword.toLowerCase()));
}

function mentionsSelfInContent(message: SessionEvent): boolean {
  if (!message.selfId) {
    return false;
  }
  if (message.platform !== "discord") {
    return false;
  }
  const escaped = message.selfId.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&");
  const pattern = new RegExp(`<@!?${escaped}>`, "g");
  return pattern.test(message.content);
}

export function extractSessionKey(input: string): {
  key: number;
  content: string;
} {
  const match = input.match(/^\s*#(\d+)(?:\s+|$)/);
  if (!match) {
    return { key: 0, content: input };
  }
  const key = Number(match[1]);
  if (!Number.isInteger(key) || key < 0) {
    return { key: 0, content: input };
  }
  return { key, content: input.slice(match[0].length) };
}
