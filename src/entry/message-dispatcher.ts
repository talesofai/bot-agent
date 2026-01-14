import { createHash } from "node:crypto";
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
import { SessionBufferStore } from "../session/buffer";

export interface MessageDispatcherOptions {
  adapter: PlatformAdapter;
  groupStore: GroupStore;
  routerStore: RouterStore | null;
  sessionQueue: BullmqSessionQueue;
  bufferStore: SessionBufferStore;
  echoTracker: EchoTracker;
  logger: Logger;
  defaultGroupId?: string;
}

export class MessageDispatcher {
  private adapter: PlatformAdapter;
  private groupStore: GroupStore;
  private routerStore: RouterStore | null;
  private sessionQueue: BullmqSessionQueue;
  private bufferStore: SessionBufferStore;
  private echoTracker: EchoTracker;
  private logger: Logger;
  private defaultGroupId?: string;

  constructor(options: MessageDispatcherOptions) {
    this.adapter = options.adapter;
    this.groupStore = options.groupStore;
    this.routerStore = options.routerStore;
    this.sessionQueue = options.sessionQueue;
    this.bufferStore = options.bufferStore;
    this.echoTracker = options.echoTracker;
    this.logger = options.logger;
    this.defaultGroupId = options.defaultGroupId;
  }

  async dispatch(message: SessionEvent): Promise<void> {
    try {
      const groupId =
        this.defaultGroupId ?? message.guildId ?? message.channelId;
      if (!groupId || !isSafePathSegment(groupId)) {
        this.logger.error({ groupId }, "Invalid groupId for message dispatch");
        return;
      }
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
      const selfId = message.selfId ?? "";
      const botConfig = selfId ? botConfigs.get(selfId) : undefined;
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
          botId: message.selfId,
          contentHash,
          contentLength: logContent.length,
        },
        "Message received",
      );

      const session = applySessionKey(message, trimmedContent, prefixLength);
      const sessionId = buildSessionId(message.userId, key);
      await this.bufferStore.append(sessionId, session);
      await this.bufferStore.markPending(sessionId);
      await this.sessionQueue.enqueue(
        {
          groupId,
          userId: message.userId,
          key,
          sessionId,
        },
        { jobId: `trigger:${groupId}:${sessionId}` },
      );
    } catch (err) {
      this.logger.error(
        { err, messageId: message.messageId },
        "Message dispatch failed",
      );
    }
  }
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
  elements: SessionElement[],
  prefixLength: number,
): SessionElement[] {
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
