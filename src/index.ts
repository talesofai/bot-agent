import { getConfig } from "./config";
import { logger } from "./logger";
import { createHash } from "node:crypto";
import path from "node:path";
import { createAdapter } from "./adapters/index";

import type { Bot, SessionEvent, SessionElement } from "./types/index";
import { BullmqResponseQueue, BullmqSessionQueue } from "./queue";
import { SessionManager, buildSessionId } from "./session";
import { GroupStore } from "./store";
import { RouterStore } from "./store/router";
import { ResponseWorker, ShellOpencodeRunner, SessionWorker } from "./worker";
import { startHttpServer, type HttpServer } from "./http/server";
import {
  extractSessionKey,
  matchesKeywords,
  shouldEnqueue,
} from "./entry/trigger";
import { EchoTracker } from "./entry/echo";
import { resolveEchoRate } from "./entry/echo-rate";

const config = getConfig();

logger.info(
  {
    env: config.NODE_ENV ?? "development",
    platform: config.PLATFORM,
    bunVersion: Bun.version,
  },
  "Bot agent starting",
);

const adapter = config.SERVICE_ROLE === "worker" ? null : createAdapter(config);
const bot: Bot | null = adapter
  ? {
      platform: adapter.platform,
      selfId: "",
      status: "disconnected",
      capabilities: {
        canEditMessage: false,
        canDeleteMessage: false,
        canSendRichContent: false,
      },
      adapter,
    }
  : null;
const sessionManager = new SessionManager();
const groupStore = adapter ? new GroupStore() : null;
const dataRoot = config.DATA_DIR ?? path.dirname(config.GROUPS_DATA_DIR);
const routerStore = adapter ? new RouterStore({ dataDir: dataRoot }) : null;
if (groupStore) {
  groupStore
    .init()
    .then(() => {
      groupStore.startWatching();
    })
    .catch((err) => {
      logger.error({ err }, "Failed to initialize GroupStore");
    });
}
const sessionQueueName = "session-jobs";
const responseQueueName = "session-responses";
const sessionQueue = new BullmqSessionQueue({
  redisUrl: config.REDIS_URL,
  queueName: sessionQueueName,
});

const responseQueue =
  config.SERVICE_ROLE === "adapter"
    ? null
    : new BullmqResponseQueue({
        redisUrl: config.REDIS_URL,
        queueName: responseQueueName,
      });

const worker =
  config.SERVICE_ROLE === "adapter"
    ? null
    : new SessionWorker({
        id: "worker-1",
        queueName: sessionQueueName,
        redisUrl: config.REDIS_URL,
        sessionManager,
        runner: new ShellOpencodeRunner(),
        logger,
        responseQueue: responseQueue ?? undefined,
      });

if (worker) {
  worker.start();
}

const responseWorker =
  adapter === null
    ? null
    : new ResponseWorker({
        id: "response-1",
        queueName: responseQueueName,
        redisUrl: config.REDIS_URL,
        adapter,
        logger,
      });

if (responseWorker) {
  responseWorker.start();
}

let httpServer: HttpServer | null = null;
startHttpServer({ logger })
  .then((server) => {
    httpServer = server;
  })
  .catch((err) => {
    logger.error({ err }, "Failed to start HTTP server");
  });

// Register message handler
const echoTracker = new EchoTracker();

if (adapter && groupStore) {
  adapter.onEvent(async (message: SessionEvent) => {
    const groupId = config.DEFAULT_GROUP_ID ?? message.channelId;
    const group = await groupStore.getGroup(groupId);
    const groupConfig = group?.config;
    if (!groupConfig || !groupConfig.enabled) {
      return;
    }
    const routerSnapshot = await routerStore?.getSnapshot();
    const globalKeywords = routerSnapshot?.globalKeywords ?? [];
    const globalEchoRate = routerSnapshot?.globalEchoRate ?? 30;
    const botConfigs = routerSnapshot?.botConfigs ?? new Map();
    const defaultRouting = {
      enableGlobal: true,
      enableGroup: true,
      enableBot: true,
    };
    const groupRouting = groupConfig.keywordRouting ?? defaultRouting;
    const selfId = message.selfId ?? "";
    const botConfig = selfId ? botConfigs.get(selfId) : undefined;
    const botRouting = botConfig?.keywordRouting ?? defaultRouting;
    const effectiveEchoRate = resolveEchoRate(
      botConfig?.echoRate,
      groupConfig.echoRate,
      globalEchoRate,
    );
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
      if (echoTracker.shouldEcho(message, effectiveEchoRate)) {
        await adapter.sendMessage(message, message.content, {
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
    logger.info(
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

    await sessionQueue.enqueue({
      groupId,
      userId: message.userId,
      key,
      sessionId: buildSessionId(message.userId, key),
      session,
    });
  });
}

// Graceful shutdown
const shutdown = async () => {
  logger.info("Shutting down...");
  try {
    if (groupStore) {
      await groupStore.stopWatching();
    }
    if (worker) {
      await worker.stop();
    }
    if (responseWorker) {
      await responseWorker.stop();
    }
    if (httpServer) {
      httpServer.stop();
    }
    if (responseQueue) {
      await responseQueue.close();
    }
    await sessionQueue.close();
    if (adapter && bot) {
      await adapter.disconnect(bot);
    }
  } catch (err) {
    logger.error({ err }, "Error during disconnect");
  } finally {
    process.exit(0);
  }
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

// Start the adapter with automatic reconnection handling
if (adapter && bot) {
  adapter.connect(bot).catch((err) => {
    // Log the initial failure, reconnect will be attempted automatically
    logger.warn(
      { err },
      "Initial connection failed, reconnect will be attempted",
    );
  });
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
