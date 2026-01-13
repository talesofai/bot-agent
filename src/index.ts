import { getConfig } from "./config";
import { logger } from "./logger";
import path from "node:path";
import { createAdapter } from "./adapters/index";

import type { Bot } from "./types/index";
import { BullmqResponseQueue, BullmqSessionQueue } from "./queue";
import { SessionManager } from "./session";
import { GroupStore } from "./store";
import { RouterStore } from "./store/router";
import { ResponseWorker, ShellOpencodeRunner, SessionWorker } from "./worker";
import { startHttpServer, type HttpServer } from "./http/server";
import { EchoTracker } from "./entry/echo";
import { MessageDispatcher } from "./entry/message-dispatcher";

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
const bot: Bot | null = adapter
  ? {
      platform: adapter.platform,
      selfId: "",
      status: "disconnected",
      capabilities: {
        canEditMessage: false,
        canDeleteMessage: false,
        canSendRichContent: false,
      },
      adapter,
    }
  : null;
const sessionManager = new SessionManager();
const groupStore = adapter ? new GroupStore() : null;
const dataRoot = config.DATA_DIR ?? path.dirname(config.GROUPS_DATA_DIR);
const routerStore = adapter ? new RouterStore({ dataDir: dataRoot }) : null;
if (groupStore) {
  groupStore
    .init()
    .then(() => {
      groupStore.startWatching();
    })
    .catch((err) => {
      logger.error({ err }, "Failed to initialize GroupStore");
    });
}
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

let httpServer: HttpServer | null = null;
startHttpServer({ logger })
  .then((server) => {
    httpServer = server;
  })
  .catch((err) => {
    logger.error({ err }, "Failed to start HTTP server");
  });

// Register message handler
const echoTracker = new EchoTracker();

if (adapter && groupStore) {
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
}

// Graceful shutdown
const shutdown = async () => {
  logger.info("Shutting down...");
  try {
    if (groupStore) {
      await groupStore.stopWatching();
    }
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
    if (adapter && bot) {
      await adapter.disconnect(bot);
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
if (adapter && bot) {
  adapter.connect(bot).catch((err) => {
    // Log the initial failure, reconnect will be attempted automatically
    logger.warn(
      { err },
      "Initial connection failed, reconnect will be attempted",
    );
  });
}
