import { createHash, randomBytes } from "node:crypto";
import type { Logger } from "pino";
import type { SessionEvent, SessionElement } from "../types/platform";
import type { PlatformAdapter } from "../types/platform";
import type { GroupStore } from "../store";
import type { RouterStore } from "../store/router";
import type { BullmqSessionQueue } from "../queue";
import { buildSessionId } from "../session";
import {
  extractSessionKey,
  resolveTriggerRule,
  shouldEnqueue,
} from "./trigger";
import { EchoTracker } from "./echo";
import { resolveEchoRate } from "./echo-rate";
import { isSafePathSegment } from "../utils/path";
import type { SessionBuffer } from "../session/buffer";
import { buildBotFsId, resolveCanonicalBotId } from "../utils/bot-id";

export interface MessageDispatcherOptions {
  adapter: PlatformAdapter;
  groupStore: GroupStore;
  routerStore: RouterStore | null;
  sessionQueue: BullmqSessionQueue;
  bufferStore: SessionBuffer;
  echoTracker: EchoTracker;
  logger: Logger;
  forceGroupId?: string;
}

export class MessageDispatcher {
  private adapter: PlatformAdapter;
  private groupStore: GroupStore;
  private routerStore: RouterStore | null;
  private sessionQueue: BullmqSessionQueue;
  private bufferStore: SessionBuffer;
  private echoTracker: EchoTracker;
  private logger: Logger;
  private forceGroupId?: string;

  constructor(options: MessageDispatcherOptions) {
    this.adapter = options.adapter;
    this.groupStore = options.groupStore;
    this.routerStore = options.routerStore;
    this.sessionQueue = options.sessionQueue;
    this.bufferStore = options.bufferStore;
    this.echoTracker = options.echoTracker;
    this.logger = options.logger;
    const forceGroupId = options.forceGroupId?.trim();
    this.forceGroupId = forceGroupId ? forceGroupId : undefined;
  }

  async dispatch(message: SessionEvent): Promise<void> {
    try {
      const groupId = resolveDispatchGroupId(message, this.forceGroupId);
      if (!groupId || !isSafePathSegment(groupId)) {
        this.logger.error({ groupId }, "Invalid groupId for message dispatch");
        return;
      }
      const rawBotId = message.selfId;
      if (!rawBotId || !isSafePathSegment(rawBotId)) {
        this.logger.error(
          { botId: rawBotId },
          "Invalid botId for message dispatch",
        );
        return;
      }
      const canonicalBotId = resolveCanonicalBotId(rawBotId);
      if (canonicalBotId !== rawBotId) {
        this.logger.info(
          { botId: rawBotId, canonicalBotId },
          "Resolved botId alias",
        );
      }
      const botId = buildBotFsId(message.platform, rawBotId);
      if (!isSafePathSegment(message.userId)) {
        this.logger.error(
          { userId: message.userId, groupId },
          "Invalid userId for message dispatch",
        );
        return;
      }
      let group = await this.groupStore.getGroup(groupId);
      if (!group) {
        await this.groupStore.ensureGroupDir(groupId);
        group = await this.groupStore.getGroup(groupId);
      }
      const groupConfig = group?.config;
      if (!groupConfig || !groupConfig.enabled) {
        return;
      }
      const routerSnapshot = await this.routerStore?.getSnapshot();
      const globalKeywords = routerSnapshot?.globalKeywords ?? [];
      const globalEchoRate = routerSnapshot?.globalEchoRate ?? 30;
      const botConfigs = routerSnapshot?.botConfigs ?? new Map();
      const botConfig = botConfigs.get(botId);
      const triggerRule = resolveTriggerRule({
        groupConfig,
        globalKeywords,
        botConfig,
      });
      const effectiveEchoRate = resolveEchoRate(
        botConfig?.echoRate,
        groupConfig.echoRate,
        globalEchoRate,
      );

      if (
        !shouldEnqueue({
          message,
          rule: triggerRule,
        })
      ) {
        if (await this.echoTracker.shouldEcho(message, effectiveEchoRate)) {
          await this.adapter.sendMessage(message, message.content, {
            elements: message.elements,
          });
        }
        return;
      }

      const { key, content, prefixLength } = extractSessionKey(message.content);
      const trimmedContent = content.trim();
      if (key >= groupConfig.maxSessions) {
        this.logger.warn(
          {
            groupId,
            userId: message.userId,
            key,
            maxSessions: groupConfig.maxSessions,
          },
          "Session key exceeds maxSessions, dropping message",
        );
        return;
      }
      const logContent =
        groupConfig.triggerMode === "keyword"
          ? message.content
          : trimmedContent;
      const contentHash = createHash("sha256")
        .update(logContent)
        .digest("hex")
        .slice(0, 12);
      this.logger.info(
        {
          id: message.messageId,
          channelId: message.channelId,
          userId: message.userId,
          botId,
          selfId: rawBotId,
          contentHash,
          contentLength: logContent.length,
        },
        "Message received",
      );

      const session = applySessionKey(message, trimmedContent, prefixLength);
      const sessionId = buildSessionId(message.userId, key);
      const bufferKey = { botId, groupId, sessionId };
      const gateToken = randomBytes(12).toString("hex");
      const acquiredToken = await this.bufferStore.appendAndRequestJob(
        bufferKey,
        session,
        gateToken,
      );
      if (!acquiredToken) {
        return;
      }
      try {
        await this.sessionQueue.enqueue({
          botId,
          groupId,
          userId: message.userId,
          key,
          sessionId,
          gateToken: acquiredToken,
        });
      } catch (err) {
        await this.bufferStore.releaseGate(bufferKey, acquiredToken);
        throw err;
      }
    } catch (err) {
      this.logger.error(
        { err, messageId: message.messageId },
        "Message dispatch failed",
      );
    }
  }
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
