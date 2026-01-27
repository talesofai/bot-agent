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
import { SessionRepository } from "../session";
import { getBotIdAliasMap } from "../utils/bot-id";
import { shutdownOtel, startOtel } from "../otel";
import { BotMessageStore } from "../store/bot-message-store";
import { GroupRouteStore } from "../store/group-route-store";
import { GroupHotPushScheduler } from "../push/scheduler";
import { createGracefulShutdown } from "../utils/graceful-shutdown";
import { WorldStore } from "../world/store";

const config = getConfig();

async function main(): Promise<void> {
  try {
    startOtel({ defaultServiceName: "opencode-bot-agent-adapter" });
  } catch (err) {
    logger.warn({ err }, "Failed to start OpenTelemetry");
  }

  let httpServer: HttpServer | null = null;
  let botMessageStore: BotMessageStore | null = null;
  let groupRouteStore: GroupRouteStore | null = null;
  let worldStore: WorldStore | null = null;
  let sessionQueue: BullmqSessionQueue | null = null;
  let bufferStore: SessionBufferStore | null = null;
  let echoTracker: EchoTracker | null = null;
  let adapter: MultiAdapter | null = null;
  let bot: Bot | null = null;
  let pushScheduler: GroupHotPushScheduler | null = null;

  const shutdownController = createGracefulShutdown({
    logger,
    name: "bot-adapter",
    onShutdown: async () => {
      try {
        if (httpServer) {
          httpServer.stop();
        }
        pushScheduler?.stop();
        await bufferStore?.close();
        await echoTracker?.close();
        await sessionQueue?.close();
        await botMessageStore?.close();
        await groupRouteStore?.close();
        await worldStore?.close();
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
  groupRouteStore = new GroupRouteStore({
    redisUrl: config.REDIS_URL,
    logger,
  });
  worldStore = new WorldStore({
    redisUrl: config.REDIS_URL,
    logger,
  });
  const platformAdapters = createPlatformAdapters(config, { botMessageStore });
  for (const platformAdapter of platformAdapters) {
    if (platformAdapter instanceof DiscordAdapter) {
      platformAdapter.enableSlashCommands();
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

  const multiAdapter = new MultiAdapter({
    adapters: platformAdapters,
    logger,
  });
  adapter = multiAdapter;
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

  const groupStore = new GroupStore();
  try {
    await groupStore.init();
  } catch (err) {
    logger.error({ err }, "Failed to initialize GroupStore");
    await shutdownController.shutdown({ exitCode: 1, reason: err });
    return;
  }
  const dataRoot = config.DATA_DIR ?? path.dirname(config.GROUPS_DATA_DIR);
  const routerStore = new RouterStore({ dataDir: dataRoot });
  try {
    await routerStore.init();
  } catch (err) {
    logger.error({ err, dataRoot }, "Failed to initialize RouterStore");
    await shutdownController.shutdown({ exitCode: 1, reason: err });
    return;
  }

  sessionQueue = new BullmqSessionQueue({
    redisUrl: config.REDIS_URL,
    queueName: "session-jobs",
    prefix: config.BULLMQ_PREFIX,
  });

  bufferStore = new SessionBufferStore({ redisUrl: config.REDIS_URL });
  const sessionRepository = new SessionRepository({
    dataDir: config.GROUPS_DATA_DIR,
    logger,
  });

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

  echoTracker = new EchoTracker({
    redisUrl: config.REDIS_URL,
    logger,
  });
  const dispatcher = new MessageDispatcher({
    adapter: multiAdapter,
    groupStore,
    routerStore,
    sessionRepository,
    sessionQueue,
    bufferStore,
    echoTracker,
    botMessageStore,
    groupRouteStore,
    worldStore,
    logger,
    forceGroupId: config.FORCE_GROUP_ID,
  });
  multiAdapter.onEvent((message) => {
    void dispatcher.dispatch(message);
  });

  pushScheduler = new GroupHotPushScheduler({
    groupsDataDir: config.GROUPS_DATA_DIR,
    dispatcher,
    groupRouteStore,
    logger,
  });
  pushScheduler.start();

  try {
    await multiAdapter.connect(botInstance);
  } catch (err) {
    logger.error({ err }, "Adapter connection failed");
    await shutdownController.shutdown({ exitCode: 1, reason: err });
  }
}

await main();
