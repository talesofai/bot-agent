import type { GroupConfig } from "../types/group";
import type { UnifiedMessage } from "../types";

export interface TriggerContext {
  cooldowns: Map<string, number>;
  now?: () => number;
}

export interface TriggerInput {
  groupId: string;
  groupConfig: GroupConfig;
  message: UnifiedMessage;
  context: TriggerContext;
}

export function shouldEnqueue(input: TriggerInput): boolean {
  const { groupId, groupConfig, message, context } = input;
  const triggerMatched =
    groupConfig.triggerMode === "mention"
      ? message.mentionsBot
      : groupConfig.triggerMode === "keyword"
        ? matchesKeywords(message.content, groupConfig.keywords)
        : groupConfig.triggerMode === "all";

  if (!triggerMatched) {
    return false;
  }
  if (groupConfig.adminUsers.includes(message.userId)) {
    return true;
  }
  if (groupConfig.cooldown > 0) {
    const now = (context.now ?? Date.now)();
    const last = context.cooldowns.get(groupId);
    const cooldownMs = groupConfig.cooldown * 1000;
    if (last && now - last < cooldownMs) {
      return false;
    }
    context.cooldowns.set(groupId, now);
  }

  return true;
}

export function matchesKeywords(content: string, keywords: string[]): boolean {
  if (keywords.length === 0) {
    return false;
  }
  const lowered = content.toLowerCase();
  return keywords.some((keyword) => lowered.includes(keyword.toLowerCase()));
}

export function extractSessionKey(input: string): {
  key: number;
  content: string;
} {
  const match = input.match(/^\s*#(\d+)\s+/);
  if (!match) {
    return { key: 0, content: input };
  }
  const key = Number(match[1]);
  if (!Number.isInteger(key) || key < 0) {
    return { key: 0, content: input };
  }
  return { key, content: input.slice(match[0].length) };
}
