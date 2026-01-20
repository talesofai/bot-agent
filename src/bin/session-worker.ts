import { getConfig } from "../config";
import { logger } from "../logger";
import { createPlatformAdapters, MultiAdapter } from "../adapters";
import { ShellOpencodeRunner, SessionWorker } from "../worker";
import { startHttpServer, type HttpServer } from "../http/server";
import type { Bot } from "../types/platform";
import { getBotIdAliasMap } from "../utils/bot-id";
import { shutdownOtel, startOtel } from "../otel";

const config = getConfig();

async function main(): Promise<void> {
  try {
    startOtel({ defaultServiceName: "opencode-bot-agent-worker" });
  } catch (err) {
    logger.warn({ err }, "Failed to start OpenTelemetry");
  }

  if (!config.DATABASE_URL) {
    logger.error("DATABASE_URL is required for session worker");
    process.exit(1);
    return;
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

  let httpServer: HttpServer | null = null;

  const shutdown = async (exitCode = 0) => {
    logger.info("Shutting down...");
    try {
      await worker.stop();
      if (httpServer) {
        httpServer.stop();
      }
      await adapter.disconnect(bot);
    } catch (err) {
      logger.error({ err }, "Error during disconnect");
    }
    try {
      await shutdownOtel();
    } catch (err) {
      logger.warn({ err }, "Failed to shutdown OpenTelemetry");
    }
    process.exit(exitCode);
  };

  process.on("SIGINT", () => {
    void shutdown(0);
  });
  process.on("SIGTERM", () => {
    void shutdown(0);
  });

  try {
    await adapter.connect(bot);
  } catch (err) {
    logger.error({ err }, "Adapter connection failed");
    await shutdown(1);
    return;
  }

  await worker.start();

  startHttpServer({ logger, port: config.WORKER_HTTP_PORT })
    .then((server) => {
      httpServer = server;
    })
    .catch((err) => {
      logger.error({ err }, "Failed to start HTTP server");
    });
}

await main();
