import { config as loadEnv } from "dotenv";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { z } from "zod";
import { zEnvBoolean } from "./utils/env";

const envSchema = z.object({
  NODE_ENV: z.string().optional(),
  /** Path to env file */
  CONFIG_PATH: z.string().optional(),
  OPENCODE_SERVER_URL: z.string().url().default("http://localhost:4096"),
  OPENCODE_SERVER_USERNAME: z.string().default("opencode"),
  OPENCODE_SERVER_PASSWORD: z.string().optional(),
  OPENCODE_SERVER_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(1_000)
    .default(600_000),
  OPENCODE_RUN_TIMEOUT_MS: z.coerce.number().int().min(1_000).default(60_000),
  /** SSRF protection: max redirects allowed for any URL fetch. */
  SSRF_MAX_REDIRECTS: z.coerce.number().int().min(0).max(10).default(3),
  /** SSRF protection: allowlist is implemented but disabled by default. */
  SSRF_ALLOWLIST_ENABLED: zEnvBoolean(false),
  /** SSRF protection: comma-separated hostname patterns (e.g. example.com,.example.com). */
  SSRF_ALLOWLIST_HOSTS: z.string().optional(),
  // OpenAI compatible configuration (optional; only used when all three are provided)
  OPENAI_BASE_URL: z.string().optional(),
  OPENAI_API_KEY: z.string().optional(),
  /** Comma-separated model IDs for litellm (slashes are allowed, e.g. vol/glm-4.7). */
  OPENCODE_MODELS: z.string().optional(),
  /** Optional override for the opencode binary path. */
  OPENCODE_BIN: z.string().optional(),
  /** Enable all tools/permissions by default when running opencode. */
  OPENCODE_YOLO: zEnvBoolean(true),
  TELEMETRY_ENABLED: zEnvBoolean(true),
  TELEMETRY_SAMPLE_RATE: z.coerce.number().min(0).max(1).default(1),
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
  FEISHU_WEBHOOK_URL: z.string().url().optional(),
  FEISHU_LOG_ENABLED: zEnvBoolean(false),
  FEISHU_LOG_MAX_BYTES: z.coerce.number().int().min(200).default(4000),
  FEISHU_LOG_QUEUE_SIZE: z.coerce.number().int().min(1).default(2000),
  FEISHU_LOG_MIN_INTERVAL_MS: z.coerce.number().int().min(0).default(200),
  FEISHU_LOG_TIMEOUT_MS: z.coerce.number().int().min(1_000).default(5_000),
  MCP_TALESOFAI_URL: z.string().url().optional(),
  REDIS_URL: z.string().default("redis://localhost:6379"),
  /** Optional BullMQ key prefix (must match producer/consumer). */
  BULLMQ_PREFIX: z.string().optional(),
  DATABASE_URL: z.string().optional(),
  BOT_ID_ALIASES: z.string().optional(),
  HTTP_PORT: z.coerce.number().int().min(1).default(8080),
  WORKER_HTTP_PORT: z.coerce.number().int().min(0).default(8081),
  API_TOKEN: z.string().optional(),
  FORCE_GROUP_ID: z.string().optional(),
  LLBOT_REGISTRY_PREFIX: z.string().default("llbot:registry"),
  LLBOT_REGISTRY_TTL_SEC: z.coerce.number().int().min(1).default(30),
  LLBOT_REGISTRY_REFRESH_SEC: z.coerce.number().int().min(1).default(10),
  LLBOT_REGISTRY_BOT_ID: z.string().optional(),
  LLBOT_REGISTRY_WS_URL: z.string().optional(),
  LLBOT_PLATFORM: z.enum(["qq", "discord"]).default("discord"),
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
