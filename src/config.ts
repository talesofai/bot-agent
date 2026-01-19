import { config as loadEnv } from "dotenv";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z.string().optional(),
  /** Path to env file */
  CONFIG_PATH: z.string().optional(),
  // OpenAI compatible configuration (optional; only used when all three are provided)
  OPENAI_BASE_URL: z.string().optional(),
  OPENAI_API_KEY: z.string().optional(),
  /** Comma-separated bare model names (litellm/<name> will be used internally). */
  OPENCODE_MODELS: z.string().optional(),
  /** Optional override for the opencode binary path. */
  OPENCODE_BIN: z.string().optional(),
  // Discord platform configuration
  DISCORD_TOKEN: z.string().optional(),
  DISCORD_APPLICATION_ID: z.string().optional(),
  GROUPS_DATA_DIR: z.string().default("/data/groups"),
  DATA_DIR: z.string().optional(),
  OPENCODE_PROMPT_MAX_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .default(500_000),
  LOG_LEVEL: z.string().default("info"),
  LOG_FORMAT: z.string().default("json"),
  MCP_TALESOFAI_URL: z.string().url().optional(),
  REDIS_URL: z.string().default("redis://localhost:6379"),
  DATABASE_URL: z.string().optional(),
  BOT_ID_ALIASES: z.string().optional(),
  HISTORY_MAX_ENTRIES: z.coerce.number().int().positive().optional(),
  HISTORY_MAX_BYTES: z.coerce.number().int().positive().optional(),
  HTTP_PORT: z.coerce.number().int().min(1).default(8080),
  WORKER_HTTP_PORT: z.coerce.number().int().min(0).default(8081),
  API_TOKEN: z.string().optional(),
  FORCE_GROUP_ID: z.string().optional(),
  LLBOT_REGISTRY_PREFIX: z.string().default("llbot:registry"),
  LLBOT_REGISTRY_TTL_SEC: z.coerce.number().int().min(1).default(30),
  LLBOT_REGISTRY_REFRESH_SEC: z.coerce.number().int().min(1).default(10),
});

export type AppConfig = z.infer<typeof envSchema>;

function createConfig(): AppConfig {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const projectRoot = path.resolve(moduleDir, "..");

  const isTestEnv = process.env.NODE_ENV === "test";
  const configPath = process.env.CONFIG_PATH;
  if (configPath) {
    const fullPath = path.resolve(projectRoot, configPath);
    loadEnv({ path: fullPath });
  } else if (!isTestEnv) {
    const defaultPath = path.resolve(projectRoot, "configs", ".env");
    if (existsSync(defaultPath)) {
      loadEnv({ path: defaultPath });
    } else {
      loadEnv();
    }
  }

  const sanitizedEnv: Record<string, string | undefined> = { ...process.env };
  for (const [key, value] of Object.entries(sanitizedEnv)) {
    if (typeof value === "string" && value.trim() === "") {
      delete sanitizedEnv[key];
    }
  }

  return envSchema.parse(sanitizedEnv);
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
