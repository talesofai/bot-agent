import { getConfig } from "./config";
import { logger } from "./logger";
import { createHash } from "node:crypto";
import { createAdapter } from "./adapters/index";

import type { UnifiedMessage } from "./types/index";
import { BullmqResponseQueue, BullmqSessionQueue } from "./queue";
import { SessionManager, buildSessionId } from "./session";
import { GroupStore } from "./store";
import { ResponseWorker, ShellOpencodeRunner, SessionWorker } from "./worker";
import { startHttpServer, type HttpServer } from "./http/server";
import { extractSessionKey, shouldEnqueue } from "./entry/trigger";

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
const sessionManager = new SessionManager();
const groupStore = adapter ? new GroupStore() : null;
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
const groupCooldowns = new Map<string, number>();
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
if (adapter && groupStore) {
  adapter.onMessage(async (message: UnifiedMessage) => {
    const groupId = config.DEFAULT_GROUP_ID ?? message.channelId;
    const group = await groupStore.getGroup(groupId);
    const groupConfig = group?.config;
    if (!groupConfig || !groupConfig.enabled) {
      return;
    }
    if (
      !shouldEnqueue({
        groupId,
        groupConfig,
        message,
        context: { cooldowns: groupCooldowns },
      })
    ) {
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
        id: message.id,
        channelId: message.channelId,
        userId: message.userId,
        contentHash,
        contentLength: logContent.length,
        mentionsBot: message.mentionsBot,
      },
      "Message received",
    );

    await sessionQueue.enqueue({
      groupId,
      userId: message.userId,
      key,
      sessionId: buildSessionId(message.userId, key),
      payload: {
        input: content,
        channelId: message.channelId,
        messageId: message.id,
        channelType: message.channelType,
        platform: message.platform,
      },
    });
  });
}

// Register connection event handlers for observability
if (adapter) {
  adapter.onConnect(() => {
    logger.info("Bot agent is running (connected)");
  });

  adapter.onDisconnect(() => {
    logger.warn("Bot agent disconnected, reconnecting...");
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
    if (adapter) {
      await adapter.disconnect();
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
if (adapter) {
  adapter.connect().catch((err) => {
    // Log the initial failure, reconnect will be attempted automatically
    logger.warn(
      { err },
      "Initial connection failed, reconnect will be attempted",
    );
  });
}
