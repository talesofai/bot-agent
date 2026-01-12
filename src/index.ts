import { getConfig } from "./config";
import { logger } from "./logger";
import { createHash } from "node:crypto";
import { createAdapter } from "./adapters/index";

import type { UnifiedMessage } from "./types/index";
import { BullmqResponseQueue, BullmqSessionQueue } from "./queue";
import { SessionManager, buildSessionId } from "./session";
import { ResponseWorker, ShellOpencodeRunner, SessionWorker } from "./worker";
import { startHttpServer } from "./http/server";

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

let httpServer: Awaited<ReturnType<typeof startHttpServer>> | null = null;
startHttpServer({ logger })
  .then((server) => {
    httpServer = server;
  })
  .catch((err) => {
    logger.error({ err }, "Failed to start HTTP server");
  });

// Register message handler
if (adapter) {
  adapter.onMessage(async (message: UnifiedMessage) => {
    const { key, content } = extractSessionKey(message.content);
    const contentHash = createHash("sha256")
      .update(content)
      .digest("hex")
      .slice(0, 12);
    logger.info(
      {
        id: message.id,
        channelId: message.channelId,
        userId: message.userId,
        contentHash,
        contentLength: content.length,
        mentionsBot: message.mentionsBot,
      },
      "Message received",
    );

    await sessionQueue.enqueue({
      groupId: message.channelId,
      userId: message.userId,
      key,
      sessionId: buildSessionId(message.userId, key),
      payload: {
        input: content,
        messageId: message.id,
        channelType: message.channelType ?? "group",
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

function extractSessionKey(input: string): { key: number; content: string } {
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
