import { getConfig } from "../config";
import { logger } from "../logger";
import { LlbotRegistrar } from "../registry/llbot-registrar";
import { createGracefulShutdown } from "../utils/graceful-shutdown";

async function main(): Promise<void> {
  const config = getConfig();

  const botId = config.LLBOT_REGISTRY_BOT_ID?.trim() ?? "";
  const wsUrl = config.LLBOT_REGISTRY_WS_URL?.trim() ?? "";
  if (!botId || !wsUrl) {
    logger.error(
      { hasBotId: Boolean(botId), hasWsUrl: Boolean(wsUrl) },
      "LLBOT_REGISTRY_BOT_ID and LLBOT_REGISTRY_WS_URL are required for llbot registrar",
    );
    process.exitCode = 1;
    return;
  }

  const registrar = new LlbotRegistrar({
    redisUrl: config.REDIS_URL,
    prefix: config.LLBOT_REGISTRY_PREFIX,
    botId,
    wsUrl,
    platform: config.LLBOT_PLATFORM,
    ttlSec: config.LLBOT_REGISTRY_TTL_SEC,
    refreshIntervalSec: config.LLBOT_REGISTRY_REFRESH_SEC,
  });

  const shutdownController = createGracefulShutdown({
    logger,
    name: "llbot-registrar",
    onShutdown: async () => {
      try {
        await registrar.stop();
      } catch (err) {
        logger.error({ err }, "Failed to stop llbot registrar");
      }
    },
  });
  shutdownController.installSignalHandlers();

  try {
    await registrar.start();
    logger.info("llbot registrar started");
  } catch (err) {
    logger.error({ err }, "Failed to start llbot registrar");
    await shutdownController.shutdown({ exitCode: 1, reason: err });
  }
}

await main();
