import { createHash } from "node:crypto";
import type { Logger } from "pino";
import type { SessionEvent, SessionElement } from "../types/platform";
import type { PlatformAdapter } from "../types/platform";
import type { GroupStore } from "../store";
import type { RouterStore } from "../store/router";
import type { BullmqSessionQueue } from "../queue";
import { buildSessionId } from "../session";
import { extractSessionKey, matchesKeywords, shouldEnqueue } from "./trigger";
import { EchoTracker } from "./echo";
import { resolveEchoRate } from "./echo-rate";

export interface MessageDispatcherOptions {
  adapter: PlatformAdapter;
  groupStore: GroupStore;
  routerStore: RouterStore | null;
  sessionQueue: BullmqSessionQueue;
  echoTracker: EchoTracker;
  logger: Logger;
  defaultGroupId?: string;
}

export class MessageDispatcher {
  private adapter: PlatformAdapter;
  private groupStore: GroupStore;
  private routerStore: RouterStore | null;
  private sessionQueue: BullmqSessionQueue;
  private echoTracker: EchoTracker;
  private logger: Logger;
  private defaultGroupId?: string;

  constructor(options: MessageDispatcherOptions) {
    this.adapter = options.adapter;
    this.groupStore = options.groupStore;
    this.routerStore = options.routerStore;
    this.sessionQueue = options.sessionQueue;
    this.echoTracker = options.echoTracker;
    this.logger = options.logger;
    this.defaultGroupId = options.defaultGroupId;
  }

  async dispatch(message: SessionEvent): Promise<void> {
    const groupId = this.defaultGroupId ?? message.channelId;
    const group = await this.groupStore.getGroup(groupId);
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
    const effectiveEchoRate = resolveEchoRate(
      botConfig?.echoRate,
      groupConfig.echoRate,
      globalEchoRate,
    );

    const defaultRouting = {
      enableGlobal: true,
      enableGroup: true,
      enableBot: true,
    };
    const groupRouting = groupConfig.keywordRouting ?? defaultRouting;
    const botRouting = botConfig?.keywordRouting ?? defaultRouting;
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
    const botKeywordMatches = new Set<string>();
    if (groupRouting.enableBot) {
      for (const [botId, config] of botConfigs) {
        if (!config.keywordRouting.enableBot) {
          continue;
        }
        if (matchesKeywords(message.content, config.keywords)) {
          botKeywordMatches.add(botId);
        }
      }
    }
    if (
      !shouldEnqueue({
        groupConfig,
        message,
        keywordMatch: {
          global: globalMatch,
          group: groupMatch,
          bot: botKeywordMatches,
        },
      })
    ) {
      if (this.echoTracker.shouldEcho(message, effectiveEchoRate)) {
        await this.adapter.sendMessage(message, message.content, {
          elements: message.elements,
        });
      }
      return;
    }

    const { key, content } = extractSessionKey(message.content);
    const logContent =
      groupConfig.triggerMode === "keyword" ? message.content : content;
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

    const session = applySessionKey(message, content);
    await this.sessionQueue.enqueue({
      groupId,
      userId: message.userId,
      key,
      sessionId: buildSessionId(message.userId, key),
      session,
    });
  }
}

function applySessionKey(message: SessionEvent, content: string): SessionEvent {
  if (content === message.content) {
    return message;
  }
  const elements = stripPrefixFromElements(
    message.elements,
    message.content,
    content,
  );
  return { ...message, content, elements };
}

function stripPrefixFromElements(
  elements: SessionElement[],
  rawContent: string,
  cleanedContent: string,
): SessionElement[] {
  const prefixIndex = rawContent.indexOf(cleanedContent);
  if (prefixIndex <= 0) {
    return elements;
  }
  let offset = prefixIndex;
  const updated: SessionElement[] = [];
  for (const element of elements) {
    if (offset === 0) {
      updated.push(element);
      continue;
    }
    if (element.type !== "text") {
      updated.push(element);
      continue;
    }
    const trimmed = element.text.slice(offset).trimStart();
    offset = 0;
    if (!trimmed) {
      continue;
    }
    updated.push({ ...element, text: trimmed });
  }
  return updated.length > 0 ? updated : elements;
}
