import type { GroupConfig, KeywordRouting, TriggerMode } from "../types/group";
import type { SessionEvent } from "../types";

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
  if (!message.guildId) {
    return true;
  }
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
  return message.elements.some(
    (element) =>
      element.type === "mention" && element.userId === message.selfId,
  );
}

export function matchesKeywords(content: string, keywords: string[]): boolean {
  if (keywords.length === 0) {
    return false;
  }
  const { content: withoutSessionKey } = extractSessionKey(content);
  const lowered = withoutSessionKey.trimStart().toLowerCase();
  return keywords.some((keyword) => matchesKeywordPrefix(lowered, keyword));
}

export function normalizeKeywords(keywords: string[]): string[] {
  return keywords
    .map((keyword) => keyword.trim().toLowerCase())
    .filter((keyword) => keyword.length > 0);
}

export function stripKeywordPrefix(
  content: string,
  keywords: string[],
): { content: string; prefixLength: number } {
  if (!content || keywords.length === 0) {
    return { content, prefixLength: 0 };
  }
  const leadingWhitespace = content.match(/^\s*/u)?.[0]?.length ?? 0;
  const withoutLeading = content.slice(leadingWhitespace);
  if (!withoutLeading) {
    return { content, prefixLength: 0 };
  }
  const lowered = withoutLeading.toLowerCase();
  const sorted = [...keywords].sort((a, b) => b.length - a.length);
  for (const keyword of sorted) {
    if (!keyword) {
      continue;
    }
    if (!matchesKeywordPrefix(lowered, keyword)) {
      continue;
    }
    let end = leadingWhitespace + keyword.length;
    while (end < content.length && isAllowedKeywordBoundary(content[end])) {
      end += 1;
    }
    return { content: content.slice(end), prefixLength: end };
  }
  return { content, prefixLength: 0 };
}

function matchesKeywordPrefix(content: string, keyword: string): boolean {
  if (!content.startsWith(keyword)) {
    return false;
  }
  const next = content.slice(keyword.length);
  if (!next) {
    return true;
  }
  return isAllowedKeywordBoundary(next[0]);
}

function isAllowedKeywordBoundary(char: string): boolean {
  if (!char) {
    return true;
  }
  if (/\s/u.test(char)) {
    return true;
  }
  // Common punctuation/symbol separators after wake words.
  if (/[，,。.!！？?：:；;、~～\-—]/u.test(char)) {
    return true;
  }
  return false;
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
