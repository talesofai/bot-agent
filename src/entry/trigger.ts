import type { GroupConfig, KeywordRouting } from "../types/group";
import type { SessionEvent } from "../types";

const selfMentionPatterns = new Map<string, RegExp>();

const DEFAULT_ROUTING: KeywordRouting = {
  enableGlobal: true,
  enableGroup: true,
  enableBot: true,
};

export interface BotKeywordConfig {
  keywords: string[];
  keywordRouting: KeywordRouting;
}

export interface TriggerContext {
  groupConfig: GroupConfig;
  message: SessionEvent;
  globalKeywords: string[];
  botConfigs: Map<string, BotKeywordConfig>;
}

export function shouldEnqueue(input: TriggerContext): boolean {
  const { groupConfig, message, globalKeywords, botConfigs } = input;
  if (mentionsSelf(message)) {
    return true;
  }
  if (groupConfig.triggerMode === "mention") {
    return false;
  }
  const groupRouting = groupConfig.keywordRouting ?? DEFAULT_ROUTING;
  const selfId = message.selfId ?? "";
  const botConfig = selfId ? botConfigs.get(selfId) : undefined;
  const botRouting = botConfig?.keywordRouting ?? DEFAULT_ROUTING;
  const effectiveRouting = {
    enableGlobal: groupRouting.enableGlobal && botRouting.enableGlobal,
    enableGroup: groupRouting.enableGroup && botRouting.enableGroup,
    enableBot: groupRouting.enableBot && botRouting.enableBot,
  };
  const globalMatch =
    effectiveRouting.enableGlobal &&
    matchesKeywords(message.content, globalKeywords);
  const groupMatch =
    effectiveRouting.enableGroup &&
    matchesKeywords(message.content, groupConfig.keywords);
  if (globalMatch || groupMatch) {
    return true;
  }
  if (!effectiveRouting.enableBot) {
    return false;
  }
  const botKeywordMatches = new Set<string>();
  for (const [botId, config] of botConfigs) {
    if (!config.keywordRouting.enableBot) {
      continue;
    }
    if (matchesKeywords(message.content, config.keywords)) {
      botKeywordMatches.add(botId);
    }
  }
  if (botKeywordMatches.size === 0) {
    return false;
  }
  return botKeywordMatches.has(selfId);
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
  const normalized = keywords
    .map((keyword) => keyword.trim())
    .filter((keyword) => keyword.length > 0);
  if (normalized.length === 0) {
    return false;
  }
  const lowered = content.toLowerCase();
  return normalized.some((keyword) => lowered.includes(keyword.toLowerCase()));
}

function mentionsSelfInContent(message: SessionEvent): boolean {
  if (!message.selfId) {
    return false;
  }
  if (message.platform !== "discord") {
    return false;
  }
  const pattern = getSelfMentionPattern(message.selfId);
  return pattern.test(message.content);
}

function getSelfMentionPattern(selfId: string): RegExp {
  const cached = selfMentionPatterns.get(selfId);
  if (cached) {
    return cached;
  }
  const escaped = selfId.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&");
  const pattern = new RegExp(`<@!?${escaped}>`);
  selfMentionPatterns.set(selfId, pattern);
  return pattern;
}

export function extractSessionKey(input: string): {
  key: number;
  content: string;
  prefixLength: number;
} {
  const match = input.match(/^\s*#(\d+)(?:\s+|$)/);
  if (!match) {
    return { key: 0, content: input, prefixLength: 0 };
  }
  const key = Number(match[1]);
  if (!Number.isInteger(key) || key < 0) {
    return { key: 0, content: input, prefixLength: 0 };
  }
  const prefixLength = match[0].length;
  return { key, content: input.slice(prefixLength), prefixLength };
}
