import { config } from "./config";
import { logger } from "./logger";
import { createAdapter } from "./adapters/index";

import type { UnifiedMessage } from "./types/index";
import { BullmqSessionQueue } from "./queue";
import { SessionManager, buildSessionId } from "./session";
import { NoopOpencodeRunner, SessionWorker } from "./worker";

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
const sessionQueue = new BullmqSessionQueue({
  redisUrl: config.REDIS_URL,
  queueName: "session-jobs",
});

const worker =
  config.SERVICE_ROLE === "adapter"
    ? null
    : new SessionWorker({
        id: "worker-1",
        queueName: "session-jobs",
        redisUrl: config.REDIS_URL,
        sessionManager,
        runner: new NoopOpencodeRunner(),
        logger,
      });

if (worker) {
  worker.start();
}

// Register message handler
if (adapter) {
  adapter.onMessage(async (message: UnifiedMessage) => {
    logger.info(
      {
        id: message.id,
        channelId: message.channelId,
        userId: message.userId,
        content: message.content.substring(0, 100),
        mentionsBot: message.mentionsBot,
      },
      "Message received",
    );

    const key = 0;
    await sessionQueue.enqueue({
      groupId: message.channelId,
      userId: message.userId,
      key,
      sessionId: buildSessionId(message.userId, key),
      payload: {
        input: message.content,
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
