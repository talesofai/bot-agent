import { config } from "./config";
import { logger } from "./logger";
import { QQAdapter } from "./adapters/qq/index";

import type { UnifiedMessage } from "./types/index";

logger.info(
  {
    env: config.NODE_ENV ?? "development",
    bunVersion: Bun.version,
  },
  "Bot agent starting",
);

const adapter = new QQAdapter();

// Register message handler
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
});

// Register connection event handlers for observability
adapter.onConnect(() => {
  logger.info("Bot agent is running (connected)");
});

adapter.onDisconnect(() => {
  logger.warn("Bot agent disconnected, reconnecting...");
});

// Graceful shutdown
const shutdown = async () => {
  logger.info("Shutting down...");
  try {
    await adapter.disconnect();
  } catch (err) {
    logger.error({ err }, "Error during disconnect");
  } finally {
    process.exit(0);
  }
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

// Start the adapter with automatic reconnection handling
adapter.connect().catch((err) => {
  // Log the initial failure, reconnect will be attempted automatically
  logger.warn({ err }, "Initial connection failed, reconnect will be attempted");
});
