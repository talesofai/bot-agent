import { createHash } from "node:crypto";

import type { SessionEvent, SessionElement } from "../types/platform";
import type { GroupConfig } from "../types/group";
import type { RouterStore } from "../store/router";
import type { SessionJobData } from "../queue";
import {
  extractSessionKey,
  resolveTriggerRule,
  stripKeywordPrefix,
  shouldEnqueue,
} from "./trigger";
import { resolveEchoRate } from "./echo-rate";
import { isSafePathSegment } from "../utils/path";
import { buildBotFsId, resolveCanonicalBotId } from "../utils/bot-id";
import type { DiceSpec } from "../utils/dice";
import { parseDiceSpec } from "../utils/dice";

export type DispatchEnvelope = {
  groupId: string;
  rawBotId: string;
  canonicalBotId: string;
  botId: string;
  userId: string;
};

export type DispatchParseError =
  | { kind: "invalid_group_id"; groupId: string | null }
  | { kind: "invalid_bot_id"; botId: string | null }
  | { kind: "invalid_user_id"; userId: string };

export type DispatchParseResult =
  | { ok: true; value: DispatchEnvelope }
  | { ok: false; error: DispatchParseError };

export function parseDispatchEnvelope(input: {
  message: SessionEvent;
  forceGroupId?: string;
}): DispatchParseResult {
  const groupId = resolveDispatchGroupId(input.message, input.forceGroupId);
  if (!groupId || !isSafePathSegment(groupId)) {
    return { ok: false, error: { kind: "invalid_group_id", groupId } };
  }

  const rawBotId = input.message.selfId?.trim() ?? "";
  if (!rawBotId || !isSafePathSegment(rawBotId)) {
    return { ok: false, error: { kind: "invalid_bot_id", botId: rawBotId } };
  }

  const userId = input.message.userId?.trim() ?? "";
  if (!userId || !isSafePathSegment(userId)) {
    return { ok: false, error: { kind: "invalid_user_id", userId } };
  }

  return {
    ok: true,
    value: {
      groupId,
      rawBotId,
      canonicalBotId: resolveCanonicalBotId(rawBotId),
      botId: buildBotFsId(input.message.platform, rawBotId),
      userId,
    },
  };
}

export type DispatchAuthResult =
  | { allowed: true; groupConfig: GroupConfig }
  | { allowed: false };

export function authorizeDispatch(input: {
  groupConfig: GroupConfig | null | undefined;
}): DispatchAuthResult {
  const groupConfig = input.groupConfig;
  if (!groupConfig || !groupConfig.enabled) {
    return { allowed: false };
  }
  return { allowed: true, groupConfig };
}

export type ManagementCommand =
  | { type: "reset"; scope: "self" | "all" }
  | { type: "model"; model: string | null }
  | {
      type: "push";
      action: "status" | "enable" | "disable" | "time";
      time?: string;
    }
  | { type: "login"; token: string | null }
  | { type: "logout" };

export type DispatchRoutingPlan =
  | { kind: "passive"; echoRate: number }
  | {
      kind: "drop";
      reason: "session_key_exceeds_max_sessions";
      key: number;
      maxSessions: number;
    }
  | {
      kind: "dice";
      key: number;
      dice: DiceSpec;
      session: SessionEvent;
      contentHash: string;
      contentLength: number;
    }
  | {
      kind: "command";
      key: number;
      command: ManagementCommand;
      contentHash: string;
      contentLength: number;
    }
  | {
      kind: "enqueue";
      key: number;
      session: SessionEvent;
      contentHash: string;
      contentLength: number;
    };

export type RouterSnapshot = Awaited<ReturnType<RouterStore["getSnapshot"]>>;

export function routeDispatch(input: {
  message: SessionEvent;
  groupConfig: GroupConfig;
  routerSnapshot: RouterSnapshot | null | undefined;
  botId: string;
  forceEnqueue?: boolean;
}): DispatchRoutingPlan {
  const globalKeywords = input.routerSnapshot?.globalKeywords ?? [];
  const globalEchoRate = input.routerSnapshot?.globalEchoRate ?? 30;
  const botConfigs = input.routerSnapshot?.botConfigs ?? new Map();
  const botConfig = botConfigs.get(input.botId);
  const triggerRule = resolveTriggerRule({
    groupConfig: input.groupConfig,
    globalKeywords,
    botConfig,
  });
  const effectiveEchoRate = resolveEchoRate(
    botConfig?.echoRate,
    input.groupConfig.echoRate,
    globalEchoRate,
  );

  const shouldHandle =
    Boolean(input.forceEnqueue) ||
    shouldEnqueue({ message: input.message, rule: triggerRule });

  const normalized = normalizeDispatchMessage({
    message: input.message,
    keywords: triggerRule.keywords,
  });

  if (normalized.key >= input.groupConfig.maxSessions) {
    return {
      kind: "drop",
      reason: "session_key_exceeds_max_sessions",
      key: normalized.key,
      maxSessions: input.groupConfig.maxSessions,
    };
  }

  const contentHash = createHash("sha256")
    .update(normalized.trimmedContent)
    .digest("hex")
    .slice(0, 12);

  const dice = parseDiceSpec(normalized.trimmedContent);
  if (dice) {
    return {
      kind: "dice",
      key: normalized.key,
      dice,
      session: normalized.session,
      contentHash,
      contentLength: normalized.trimmedContent.length,
    };
  }

  if (normalized.trimmedContent.match(/^\/nano\b/i)) {
    return {
      kind: "enqueue",
      key: normalized.key,
      session: normalized.session,
      contentHash,
      contentLength: normalized.trimmedContent.length,
    };
  }

  if (!shouldHandle) {
    return { kind: "passive", echoRate: effectiveEchoRate };
  }

  const command = parseManagementCommand(normalized.trimmedContent);
  if (command) {
    return {
      kind: "command",
      key: normalized.key,
      command,
      contentHash,
      contentLength: normalized.trimmedContent.length,
    };
  }

  return {
    kind: "enqueue",
    key: normalized.key,
    session: normalized.session,
    contentHash,
    contentLength: normalized.trimmedContent.length,
  };
}

export function normalizeDispatchMessage(input: {
  message: SessionEvent;
  keywords: string[];
}): { key: number; trimmedContent: string; session: SessionEvent } {
  let normalizedMessage = input.message;

  const wakePrefixFirst = stripKeywordPrefix(
    normalizedMessage.content,
    input.keywords,
  );
  normalizedMessage = applySessionKey(
    normalizedMessage,
    wakePrefixFirst.content,
    wakePrefixFirst.prefixLength,
  );

  const { key, content, prefixLength } = extractSessionKey(
    normalizedMessage.content,
  );
  normalizedMessage = applySessionKey(normalizedMessage, content, prefixLength);

  const wakePrefixSecond = stripKeywordPrefix(
    normalizedMessage.content,
    input.keywords,
  );
  normalizedMessage = applySessionKey(
    normalizedMessage,
    wakePrefixSecond.content,
    wakePrefixSecond.prefixLength,
  );

  const trimmedContent = normalizedMessage.content.trim();
  normalizedMessage = applySessionKey(normalizedMessage, trimmedContent, 0);

  return { key, trimmedContent, session: normalizedMessage };
}

export function planEnqueue(input: {
  envelope: DispatchEnvelope;
  sessionId: string;
  key: number;
  gateToken: string;
  traceId: string;
  traceStartedAt: number;
}): {
  bufferKey: { botId: string; groupId: string; sessionId: string };
  jobData: SessionJobData;
} {
  return {
    bufferKey: {
      botId: input.envelope.botId,
      groupId: input.envelope.groupId,
      sessionId: input.sessionId,
    },
    jobData: {
      botId: input.envelope.botId,
      groupId: input.envelope.groupId,
      userId: input.envelope.userId,
      key: input.key,
      sessionId: input.sessionId,
      gateToken: input.gateToken,
      traceId: input.traceId,
      traceStartedAt: input.traceStartedAt,
    },
  };
}

export function resolveDispatchGroupId(
  message: SessionEvent,
  forceGroupId?: string,
): string | null {
  if (!message.guildId) {
    return "0";
  }
  if (forceGroupId) {
    return forceGroupId;
  }
  return message.guildId;
}

function applySessionKey(
  message: SessionEvent,
  content: string,
  prefixLength: number,
): SessionEvent {
  if (content === message.content) {
    return message;
  }
  const elements = stripPrefixFromElements(message.elements, prefixLength);
  return { ...message, content, elements };
}

function stripPrefixFromElements(
  elements: ReadonlyArray<SessionElement>,
  prefixLength: number,
): ReadonlyArray<SessionElement> {
  if (prefixLength <= 0) {
    return elements;
  }
  let remaining = prefixLength;
  const updated: SessionElement[] = [];
  for (const element of elements) {
    if (element.type !== "text") {
      updated.push(element);
      continue;
    }
    if (remaining <= 0) {
      updated.push(element);
      continue;
    }
    if (element.text.length <= remaining) {
      remaining -= element.text.length;
      continue;
    }
    const sliced = element.text.slice(remaining);
    remaining = 0;
    if (sliced) {
      updated.push({ ...element, text: sliced });
    }
  }
  return updated;
}

function parseManagementCommand(input: string): ManagementCommand | null {
  const trimmed = input.trim();
  if (!trimmed) {
    return null;
  }

  if (trimmed.match(/^(?:\/resetall|resetall)$/i) || trimmed === "重置全群") {
    return { type: "reset", scope: "all" };
  }

  const resetMatch =
    trimmed.match(/^(?:\/reset|reset)(?:\s+(.+))?$/i) ??
    trimmed.match(/^(?:\/重置|重置)(?:\s+(.+))?$/);
  if (resetMatch) {
    const arg = resetMatch[1]?.trim() ?? "";
    if (!arg) {
      return { type: "reset", scope: "self" };
    }
    const loweredArg = arg.toLowerCase();
    if (
      loweredArg === "all" ||
      loweredArg === "everyone" ||
      arg === "所有人" ||
      arg === "全群"
    ) {
      return { type: "reset", scope: "all" };
    }
    return null;
  }

  const modelMatch =
    trimmed.match(/^(?:\/model|model)(?:\s+|$)(.*)$/i) ??
    trimmed.match(/^(?:\/模型|模型)(?:\s+|$)(.*)$/);
  if (modelMatch) {
    const rawArg = modelMatch[1]?.trim() ?? "";
    if (!rawArg) {
      return { type: "model", model: "" };
    }
    if (
      ["default", "clear", "none", "off", "reset", "默认"].includes(
        rawArg.toLowerCase(),
      )
    ) {
      return { type: "model", model: null };
    }
    return { type: "model", model: rawArg };
  }

  const pushMatch =
    trimmed.match(/^(?:\/push|push)(?:\s+(.+))?$/i) ??
    trimmed.match(/^(?:\/推送|推送)(?:\s+(.+))?$/);
  if (pushMatch) {
    const arg = pushMatch[1]?.trim() ?? "";
    if (!arg) {
      return { type: "push", action: "status" };
    }
    const lowered = arg.toLowerCase();
    if (
      ["on", "enable", "enabled", "1", "true", "开", "开启", "启用"].includes(
        lowered,
      )
    ) {
      return { type: "push", action: "enable" };
    }
    if (
      [
        "off",
        "disable",
        "disabled",
        "0",
        "false",
        "关",
        "关闭",
        "停用",
      ].includes(lowered)
    ) {
      return { type: "push", action: "disable" };
    }
    const timeMatch =
      arg.match(/^(?:time|at|时间)\s+(\d{1,2}:\d{2})$/i) ??
      arg.match(/^(\d{1,2}:\d{2})$/);
    if (timeMatch) {
      return { type: "push", action: "time", time: timeMatch[1] };
    }
    return { type: "push", action: "status" };
  }

  const loginMatch = trimmed.match(/^(?:\/login|login)(?:\s+(.+))?$/i);
  if (loginMatch) {
    const token = loginMatch[1]?.trim() ?? "";
    return { type: "login", token: token ? token : null };
  }

  if (trimmed.match(/^(?:\/logout|logout)$/i)) {
    return { type: "logout" };
  }

  return null;
}
