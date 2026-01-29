import { getConfig } from "../config";
import { logger } from "../logger";
import { createPlatformAdapters, MultiAdapter } from "../adapters";
import { OpencodeServerRunner, SessionWorker } from "../worker";
import { OpencodeServerClient } from "../opencode/server-client";
import { startHttpServer, type HttpServer } from "../http/server";
import type { Bot } from "../types/platform";
import { getBotIdAliasMap } from "../utils/bot-id";
import { shutdownOtel, startOtel } from "../otel";
import { BotMessageStore } from "../store/bot-message-store";
import { createGracefulShutdown } from "../utils/graceful-shutdown";

const config = getConfig();

async function main(): Promise<void> {
  try {
    startOtel({ defaultServiceName: "opencode-bot-agent-worker" });
  } catch (err) {
    logger.warn({ err }, "Failed to start OpenTelemetry");
  }

  let httpServer: HttpServer | null = null;
  let botMessageStore: BotMessageStore | null = null;
  let worker: SessionWorker | null = null;
  let adapter: MultiAdapter | null = null;
  let bot: Bot | null = null;

  const shutdownController = createGracefulShutdown({
    logger,
    name: "session-worker",
    onShutdown: async () => {
      try {
        await worker?.stop();
        if (httpServer) {
          httpServer.stop();
        }
        await botMessageStore?.close();
        if (adapter && bot) {
          await adapter.disconnect(bot);
        }
      } catch (err) {
        logger.error({ err }, "Error during shutdown");
      }
      try {
        await shutdownOtel();
      } catch (err) {
        logger.warn({ err }, "Failed to shutdown OpenTelemetry");
      }
    },
  });
  shutdownController.installSignalHandlers();

  botMessageStore = new BotMessageStore({
    redisUrl: config.REDIS_URL,
    logger,
  });
  const platformAdapters = createPlatformAdapters(config, { botMessageStore });

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
  const multiAdapter = new MultiAdapter({
    adapters: platformAdapters,
    logger,
  });
  adapter = multiAdapter;

  const opencodeClient = new OpencodeServerClient({
    baseUrl: config.OPENCODE_SERVER_URL,
    username: config.OPENCODE_SERVER_USERNAME,
    password: config.OPENCODE_SERVER_PASSWORD,
    timeoutMs: config.OPENCODE_SERVER_TIMEOUT_MS,
  });

  const botInstance: Bot = {
    platform: multiAdapter.platform,
    selfId: "",
    status: "disconnected",
    capabilities: {
      canEditMessage: false,
      canDeleteMessage: false,
      canSendRichContent: false,
    },
    adapter: multiAdapter,
  };
  bot = botInstance;

  worker = new SessionWorker({
    id: "worker-1",
    dataDir: config.GROUPS_DATA_DIR,
    adapter: multiAdapter,
    opencodeClient,
    onFatalError: async (err) => {
      logger.error({ err }, "Session worker crashed");
      await shutdownController.shutdown({ exitCode: 1, reason: err });
    },
    redis: {
      url: config.REDIS_URL,
    },
    queue: {
      name: sessionQueueName,
      prefix: config.BULLMQ_PREFIX,
      concurrency: config.SESSION_WORKER_CONCURRENCY,
    },
    runner: new OpencodeServerRunner(opencodeClient),
    logger,
  });

  try {
    await multiAdapter.connect(botInstance);
  } catch (err) {
    logger.error({ err }, "Adapter connection failed");
    await shutdownController.shutdown({ exitCode: 1, reason: err });
    return;
  }

  try {
    await worker.start();
  } catch (err) {
    logger.error({ err }, "Session worker failed to start");
    await shutdownController.shutdown({ exitCode: 1, reason: err });
    return;
  }

  try {
    httpServer = await startHttpServer({
      logger,
      port: config.WORKER_HTTP_PORT,
    });
  } catch (err) {
    logger.error({ err }, "Failed to start HTTP server");
    await shutdownController.shutdown({ exitCode: 1, reason: err });
    return;
  }
}

await main();
