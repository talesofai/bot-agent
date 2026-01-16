import { getConfig } from "../config";
import { logger } from "../logger";
import { createPlatformAdapters, MultiAdapter } from "../adapters";
import { ShellOpencodeRunner, SessionWorker } from "../worker";
import { startHttpServer, type HttpServer } from "../http/server";
import type { Bot } from "../types/platform";
import { getBotIdAliasMap } from "../utils/bot-id";

const config = getConfig();
if (!config.DATABASE_URL) {
  throw new Error("DATABASE_URL is required for session worker");
}

const platformAdapters = createPlatformAdapters(config);

logger.info(
  {
    env: config.NODE_ENV ?? "development",
    platforms: platformAdapters.map((adapter) => adapter.platform),
    bunVersion: Bun.version,
  },
  "Session worker starting",
);
const aliasMap = getBotIdAliasMap();
if (aliasMap.size > 0) {
  logger.info(
    { botIdAliases: Object.fromEntries(aliasMap.entries()) },
    "Loaded bot id aliases",
  );
}

const sessionQueueName = "session-jobs";
const adapter = new MultiAdapter({
  adapters: platformAdapters,
  logger,
});

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
  limits: {
    historyEntries: config.HISTORY_MAX_ENTRIES,
    historyBytes: config.HISTORY_MAX_BYTES,
  },
  runner: new ShellOpencodeRunner(),
  logger,
});
adapter.connect(bot).catch((err) => {
  logger.warn({ err }, "Adapter connection failed");
});
worker.start();

let httpServer: HttpServer | null = null;
startHttpServer({ logger, port: config.WORKER_HTTP_PORT })
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
