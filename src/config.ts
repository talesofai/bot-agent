import { config as loadEnv } from "dotenv";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { z } from "zod";

const envSchema = z
  .object({
    NODE_ENV: z.string().optional(),
    /** Platform to use: qq or discord */
    PLATFORM: z.enum(["qq", "discord"]).default("qq"),
    /** Path to env file */
    CONFIG_PATH: z.string().optional(),
    // Discord platform configuration
    DISCORD_TOKEN: z.string().optional(),
    DISCORD_APPLICATION_ID: z.string().optional(),
    GROUPS_DATA_DIR: z.string().default("/data/groups"),
    DATA_DIR: z.string().optional(),
    OPENCODE_MODEL: z.string().default("claude-sonnet-4-20250514"),
    LOG_LEVEL: z.string().default("info"),
    LOG_FORMAT: z.string().default("json"),
    MCP_TALESOFAI_URL: z.string().url().optional(),
    REDIS_URL: z.string().default("redis://localhost:6379"),
    DATABASE_URL: z.string().optional(),
    BOT_ID_ALIASES: z.string().optional(),
    HISTORY_MAX_ENTRIES: z.coerce.number().int().positive().optional(),
    HISTORY_MAX_BYTES: z.coerce.number().int().positive().optional(),
    HTTP_PORT: z.coerce.number().int().min(1).default(8080),
    DEFAULT_GROUP_ID: z.string().optional(),
    LLBOT_REGISTRY_PREFIX: z.string().default("llbot:registry"),
    LLBOT_REGISTRY_TTL_SEC: z.coerce.number().int().min(1).default(30),
    LLBOT_REGISTRY_REFRESH_SEC: z.coerce.number().int().min(1).default(10),
  })
  .superRefine((data, ctx) => {
    if (data.PLATFORM === "discord" && !data.DISCORD_TOKEN) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "DISCORD_TOKEN is required for Discord platform",
        path: ["DISCORD_TOKEN"],
      });
    }
  });

export type AppConfig = z.infer<typeof envSchema>;

function createConfig(): AppConfig {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const projectRoot = path.resolve(moduleDir, "..");

  const configPath = process.env.CONFIG_PATH;
  if (configPath) {
    const fullPath = path.resolve(projectRoot, configPath);
    loadEnv({ path: fullPath });
  } else {
    loadEnv();
  }

  return envSchema.parse(process.env);
}

let cachedConfig: AppConfig | null = null;

export function getConfig(): AppConfig {
  if (!cachedConfig) {
    cachedConfig = createConfig();
  }
  return cachedConfig;
}

export function resetConfig(): void {
  cachedConfig = null;
}
