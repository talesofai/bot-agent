import { config as loadEnv } from "dotenv";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { z } from "zod";

const PLATFORM_VALUES = ["qq", "discord"] as const;
type Platform = (typeof PLATFORM_VALUES)[number];

const envSchema = z.object({
  NODE_ENV: z.string().optional(),
  /** Platform to use: qq or discord (comma-separated for multi-platform) */
  PLATFORM: z.string().default("qq"),
  /** Optional comma-separated platform list, overrides PLATFORM when provided */
  PLATFORMS: z.string().optional(),
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
});

type EnvConfig = z.infer<typeof envSchema>;

export type AppConfig = EnvConfig & { platforms: Platform[] };

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

  const env = envSchema.parse(process.env);
  const platforms = parsePlatforms(env);
  if (platforms.includes("discord") && !env.DISCORD_TOKEN) {
    throw new Error("DISCORD_TOKEN is required when using Discord platform");
  }
  return { ...env, platforms };
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

function parsePlatforms(env: EnvConfig): Platform[] {
  const raw = env.PLATFORMS ?? env.PLATFORM;
  const parts = raw
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
  const defaults = parts.length === 0 ? ["qq"] : parts;
  const set = new Set<Platform>();
  for (const platform of defaults) {
    if (!PLATFORM_VALUES.includes(platform as Platform)) {
      throw new Error(`Unsupported platform: ${platform}`);
    }
    set.add(platform as Platform);
  }
  if (env.DISCORD_TOKEN && !set.has("discord")) {
    set.add("discord");
  }
  return Array.from(set.values());
}
