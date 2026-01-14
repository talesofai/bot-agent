import { z } from "zod";
import { logger } from "../logger";
import { SessionTtlCleaner } from "../session/ttl-cleaner";

const envSchema = z.object({
  GROUPS_DATA_DIR: z.string().default("/data/groups"),
  CLEAN_SESSIONS_TTL_DAYS: z.coerce.number().int().min(1).default(30),
  REDIS_URL: z.string().optional(),
  CLEAN_SESSIONS_SKIP_REDIS: z.enum(["true", "false"]).optional(),
});

const env = envSchema.parse(process.env);
const ttlMs = env.CLEAN_SESSIONS_TTL_DAYS * 24 * 60 * 60 * 1000;
const redisUrl =
  env.CLEAN_SESSIONS_SKIP_REDIS === "true" ? null : env.REDIS_URL;

const cleaner = new SessionTtlCleaner({
  dataDir: env.GROUPS_DATA_DIR,
  logger,
  ttlMs,
  redisUrl,
});

async function main(): Promise<void> {
  logger.info(
    { ttlDays: env.CLEAN_SESSIONS_TTL_DAYS },
    "Starting session cleanup",
  );
  let exitCode = 0;
  try {
    const removed = await cleaner.cleanup();
    logger.info({ removed }, "Session cleanup finished");
  } catch (err) {
    logger.error({ err }, "Session cleanup failed");
    exitCode = 1;
  } finally {
    await cleaner.close();
  }
  process.exit(exitCode);
}

await main();
