import { getConfig } from "../config";
import { logger } from "../logger";
import { DiscordAdapter } from "../adapters/discord";
import { QQAdapterPool } from "../adapters/qq";
import { ShellOpencodeRunner, SessionWorker } from "../worker";
import { startHttpServer, type HttpServer } from "../http/server";
import type { Bot } from "../types/platform";

const config = getConfig();
if (!config.DATABASE_URL) {
  throw new Error("DATABASE_URL is required for session worker");
}

logger.info(
  {
    env: config.NODE_ENV ?? "development",
    bunVersion: Bun.version,
  },
  "Session worker starting",
);

const sessionQueueName = "session-jobs";
let adapter;
switch (config.PLATFORM) {
  case "qq":
    adapter = new QQAdapterPool({
      redisUrl: config.REDIS_URL,
      registryPrefix: config.LLBOT_REGISTRY_PREFIX,
    });
    break;
  case "discord":
    adapter = new DiscordAdapter({
      token: config.DISCORD_TOKEN,
    });
    break;
  default:
    throw new Error(`Unknown platform: ${config.PLATFORM}`);
}

const bot: Bot = {
  platform: adapter.platform,
  selfId: "",
  status: "disconnected",
  capabilities: {
    canEditMessage: false,
    canDeleteMessage: false,
    canSendRichContent: false,
  },
  adapter,
};

const worker = new SessionWorker({
  id: "worker-1",
  dataDir: config.GROUPS_DATA_DIR,
  adapter,
  databaseUrl: config.DATABASE_URL,
  redis: {
    url: config.REDIS_URL,
  },
  queue: {
    name: sessionQueueName,
  },
  runner: new ShellOpencodeRunner(),
  logger,
});
adapter.connect(bot).catch((err) => {
  logger.warn({ err }, "Adapter connection failed");
});
worker.start();

let httpServer: HttpServer | null = null;
startHttpServer({ logger })
  .then((server) => {
    httpServer = server;
  })
  .catch((err) => {
    logger.error({ err }, "Failed to start HTTP server");
  });

const shutdown = async () => {
  logger.info("Shutting down...");
  try {
    await worker.stop();
    if (httpServer) {
      httpServer.stop();
    }
    await adapter.disconnect(bot);
  } catch (err) {
    logger.error({ err }, "Error during disconnect");
  } finally {
    process.exit(0);
  }
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
