import type { GroupConfig, KeywordRouting, TriggerMode } from "../types/group";
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

export interface TriggerRule {
  triggerMode: TriggerMode;
  keywords: string[];
}

export interface TriggerDecisionInput {
  message: SessionEvent;
  rule: TriggerRule;
}

export interface ResolveTriggerRuleInput {
  groupConfig: GroupConfig;
  globalKeywords: string[];
  botConfig?: BotKeywordConfig;
}

export function resolveTriggerRule(
  input: ResolveTriggerRuleInput,
): TriggerRule {
  const { groupConfig, globalKeywords, botConfig } = input;
  const groupRouting = groupConfig.keywordRouting ?? DEFAULT_ROUTING;
  const botRouting = botConfig?.keywordRouting ?? DEFAULT_ROUTING;

  const keywords: string[] = [];
  if (groupRouting.enableGlobal && botRouting.enableGlobal) {
    keywords.push(...normalizeKeywords(globalKeywords));
  }
  if (groupRouting.enableGroup && botRouting.enableGroup) {
    keywords.push(...normalizeKeywords(groupConfig.keywords));
  }
  if (groupRouting.enableBot && botRouting.enableBot && botConfig) {
    keywords.push(...normalizeKeywords(botConfig.keywords));
  }

  return {
    triggerMode: groupConfig.triggerMode,
    keywords: Array.from(new Set(keywords)),
  };
}

export function shouldEnqueue(input: TriggerDecisionInput): boolean {
  const { message, rule } = input;
  if (mentionsSelf(message)) {
    return true;
  }
  if (rule.triggerMode === "mention") {
    return false;
  }
  return matchesKeywords(message.content, rule.keywords);
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
  return keywords.some((keyword) => lowered.includes(keyword));
}

export function normalizeKeywords(keywords: string[]): string[] {
  return keywords
    .map((keyword) => keyword.trim().toLowerCase())
    .filter((keyword) => keyword.length > 0);
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
