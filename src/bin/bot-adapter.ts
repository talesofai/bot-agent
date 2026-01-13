import path from "node:path";
import { getConfig } from "../config";
import { createAdapter } from "../adapters";
import { logger } from "../logger";
import { GroupStore } from "../store";
import { RouterStore } from "../store/router";
import { BullmqSessionQueue } from "../queue";
import { EchoTracker } from "../entry/echo";
import { MessageDispatcher } from "../entry/message-dispatcher";
import { ResponseWorker } from "../worker";
import { startHttpServer, type HttpServer } from "../http/server";
import type { Bot } from "../types/platform";

const config = getConfig();

logger.info(
  {
    env: config.NODE_ENV ?? "development",
    platform: config.PLATFORM,
    bunVersion: Bun.version,
  },
  "Bot adapter starting",
);

const adapter = createAdapter(config);
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
const dataRoot = config.DATA_DIR ?? path.dirname(config.GROUPS_DATA_DIR);
const routerStore = new RouterStore({ dataDir: dataRoot });
groupStore
  .init()
  .then(() => {
    groupStore.startWatching();
  })
  .catch((err) => {
    logger.error({ err }, "Failed to initialize GroupStore");
  });

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

let httpServer: HttpServer | null = null;
startHttpServer({ logger })
  .then((server) => {
    httpServer = server;
  })
  .catch((err) => {
    logger.error({ err }, "Failed to start HTTP server");
  });

const echoTracker = new EchoTracker();
const dispatcher = new MessageDispatcher({
  adapter,
  groupStore,
  routerStore,
  sessionQueue,
  echoTracker,
  logger,
  defaultGroupId: config.DEFAULT_GROUP_ID,
});
adapter.onEvent((message) => dispatcher.dispatch(message));

const shutdown = async () => {
  logger.info("Shutting down...");
  try {
    await groupStore.stopWatching();
    await responseWorker.stop();
    if (httpServer) {
      httpServer.stop();
    }
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
