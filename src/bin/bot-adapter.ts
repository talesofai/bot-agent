import path from "node:path";
import { getConfig } from "../config";
import { DiscordAdapter } from "../adapters/discord";
import { QQAdapterPool } from "../adapters/qq";
import { logger } from "../logger";
import { GroupStore } from "../store";
import { RouterStore } from "../store/router";
import { BullmqSessionQueue } from "../queue";
import { EchoTracker } from "../entry/echo";
import { MessageDispatcher } from "../entry/message-dispatcher";
import { ResponseWorker } from "../worker";
import { startHttpServer, type HttpServer } from "../http/server";
import type { Bot } from "../types/platform";
import { SessionBufferStore } from "../session/buffer";

const config = getConfig();

async function main(): Promise<void> {
  logger.info(
    {
      env: config.NODE_ENV ?? "development",
      platform: config.PLATFORM,
      bunVersion: Bun.version,
    },
    "Bot adapter starting",
  );

  let adapter;
  switch (config.PLATFORM) {
    case "qq":
      adapter = new QQAdapterPool({
        redisUrl: config.REDIS_URL,
        registryPrefix: config.LLBOT_REGISTRY_PREFIX,
        refreshIntervalSec: config.LLBOT_REGISTRY_REFRESH_SEC,
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

  const sessionQueue = new BullmqSessionQueue({
    redisUrl: config.REDIS_URL,
    queueName: "session-jobs",
  });

  const responseWorker = new ResponseWorker({
    id: "response-1",
    queueName: "session-responses",
    redisUrl: config.REDIS_URL,
    adapter,
    logger,
  });
  responseWorker.start();

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
    defaultGroupId: config.DEFAULT_GROUP_ID,
  });
  adapter.onEvent((message) => {
    void dispatcher.dispatch(message);
  });

  const shutdown = async () => {
    logger.info("Shutting down...");
    try {
      await responseWorker.stop();
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
      process.exit(0);
    }
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  adapter.connect(bot).catch((err) => {
    logger.warn(
      { err },
      "Initial connection failed, reconnect will be attempted",
    );
  });
}

await main();
