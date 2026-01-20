import path from "node:path";
import { getConfig } from "../config";
import { createPlatformAdapters, MultiAdapter } from "../adapters";
import { DiscordAdapter } from "../adapters/discord";
import { logger } from "../logger";
import { GroupStore } from "../store";
import { RouterStore } from "../store/router";
import { BullmqSessionQueue } from "../queue";
import { EchoTracker } from "../entry/echo";
import { MessageDispatcher } from "../entry/message-dispatcher";
import { startHttpServer, type HttpServer } from "../http/server";
import type { Bot } from "../types/platform";
import { SessionBufferStore } from "../session/buffer";
import { getBotIdAliasMap } from "../utils/bot-id";

const config = getConfig();

async function main(): Promise<void> {
  const platformAdapters = createPlatformAdapters(config);
  for (const adapter of platformAdapters) {
    if (adapter instanceof DiscordAdapter) {
      adapter.enableSlashCommands();
    }
  }
  logger.info(
    {
      env: config.NODE_ENV ?? "development",
      platforms: platformAdapters.map((adapter) => adapter.platform),
      bunVersion: Bun.version,
    },
    "Bot adapter starting",
  );

  const aliasMap = getBotIdAliasMap();
  if (aliasMap.size > 0) {
    logger.info(
      { botIdAliases: Object.fromEntries(aliasMap.entries()) },
      "Loaded bot id aliases",
    );
  }

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

  const groupStore = new GroupStore();
  try {
    await groupStore.init();
  } catch (err) {
    logger.error({ err }, "Failed to initialize GroupStore");
    process.exit(1);
    return;
  }
  const dataRoot = config.DATA_DIR ?? path.dirname(config.GROUPS_DATA_DIR);
  const routerStore = new RouterStore({ dataDir: dataRoot });
  try {
    await routerStore.init();
  } catch (err) {
    logger.error({ err, dataRoot }, "Failed to initialize RouterStore");
    process.exit(1);
    return;
  }

  const sessionQueue = new BullmqSessionQueue({
    redisUrl: config.REDIS_URL,
    queueName: "session-jobs",
  });

  const bufferStore = new SessionBufferStore({ redisUrl: config.REDIS_URL });

  let httpServer: HttpServer | null = null;
  startHttpServer({
    logger,
    onReloadGroup: async (groupId) =>
      Boolean(await groupStore.reloadGroup(groupId)),
  })
    .then((server) => {
      httpServer = server;
    })
    .catch((err) => {
      logger.error({ err }, "Failed to start HTTP server");
    });

  const echoTracker = new EchoTracker({
    redisUrl: config.REDIS_URL,
    logger,
  });
  const dispatcher = new MessageDispatcher({
    adapter,
    groupStore,
    routerStore,
    sessionQueue,
    bufferStore,
    echoTracker,
    logger,
    forceGroupId: config.FORCE_GROUP_ID,
  });
  adapter.onEvent((message) => {
    void dispatcher.dispatch(message);
  });

  const shutdown = async (exitCode = 0) => {
    logger.info("Shutting down...");
    try {
      if (httpServer) {
        httpServer.stop();
      }
      await bufferStore.close();
      await echoTracker.close();
      await sessionQueue.close();
      await adapter.disconnect(bot);
    } catch (err) {
      logger.error({ err }, "Error during disconnect");
    } finally {
      process.exit(exitCode);
    }
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
  }
}

await main();
