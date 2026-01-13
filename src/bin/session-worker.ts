import { getConfig } from "../config";
import { logger } from "../logger";
import { SessionManager } from "../session";
import { BullmqResponseQueue, BullmqSessionQueue } from "../queue";
import { ShellOpencodeRunner, SessionWorker } from "../worker";
import { startHttpServer, type HttpServer } from "../http/server";

const config = getConfig();

logger.info(
  {
    env: config.NODE_ENV ?? "development",
    bunVersion: Bun.version,
  },
  "Session worker starting",
);

const sessionManager = new SessionManager();
const sessionQueueName = "session-jobs";
const responseQueueName = "session-responses";

const responseQueue = new BullmqResponseQueue({
  redisUrl: config.REDIS_URL,
  queueName: responseQueueName,
});

const worker = new SessionWorker({
  id: "worker-1",
  redis: {
    url: config.REDIS_URL,
  },
  queue: {
    name: sessionQueueName,
  },
  sessionManager,
  runner: new ShellOpencodeRunner(),
  logger,
  responseQueue,
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
    await responseQueue.close();
  } catch (err) {
    logger.error({ err }, "Error during disconnect");
  } finally {
    process.exit(0);
  }
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
