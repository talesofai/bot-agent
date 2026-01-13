import { z } from "zod";
import { logger } from "./logger";
import { LlbotRegistrar } from "./registry/llbot-registrar";

const envSchema = z.object({
  REDIS_URL: z.string().default("redis://localhost:6379"),
  LLBOT_REGISTRY_PREFIX: z.string().default("llbot:registry"),
  LLBOT_REGISTRY_TTL_SEC: z.coerce.number().int().min(1).default(30),
  LLBOT_REGISTRY_REFRESH_SEC: z.coerce.number().int().min(1).default(10),
  LLBOT_REGISTRY_BOT_ID: z.string().min(1),
  LLBOT_REGISTRY_WS_URL: z.string().min(1),
  LLBOT_PLATFORM: z.enum(["qq", "discord"]).default("qq"),
});

const config = envSchema.parse(process.env);

const registrar = new LlbotRegistrar({
  redisUrl: config.REDIS_URL,
  prefix: config.LLBOT_REGISTRY_PREFIX,
  botId: config.LLBOT_REGISTRY_BOT_ID,
  wsUrl: config.LLBOT_REGISTRY_WS_URL,
  platform: config.LLBOT_PLATFORM,
  ttlSec: config.LLBOT_REGISTRY_TTL_SEC,
  refreshIntervalSec: config.LLBOT_REGISTRY_REFRESH_SEC,
});

const shutdown = async () => {
  logger.info("Shutting down llbot registrar...");
  await registrar.stop();
  process.exit(0);
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

await registrar.start();
logger.info("llbot registrar started");
