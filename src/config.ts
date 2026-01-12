import { config as loadEnv } from "dotenv";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z.string().optional(),
  /** Platform to use: qq or discord */
  PLATFORM: z.enum(["qq", "discord"]).default("qq"),
  // QQ platform configuration
  MILKY_URL: z.string().url().optional(),
  // Discord platform configuration
  DISCORD_TOKEN: z.string().optional(),
  DISCORD_APPLICATION_ID: z.string().optional(),
  GROUPS_DATA_DIR: z.string().default("/data/groups"),
  OPENCODE_MODEL: z.string().default("claude-sonnet-4-20250514"),
  LOG_LEVEL: z.string().default("info"),
  LOG_FORMAT: z.string().default("json"),
  MCP_TALESOFAI_URL: z.string().url().optional(),
});

export type AppConfig = z.infer<typeof envSchema>;

function createConfig(): AppConfig {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const projectRoot = path.resolve(moduleDir, "..");

  const envPaths = ["configs/.env", "configs/secrets/.env"];
  for (const relativePath of envPaths) {
    const fullPath = path.resolve(projectRoot, relativePath);
    if (existsSync(fullPath)) {
      loadEnv({ path: fullPath });
    } else {
      console.warn(`Env file not found: ${fullPath}`);
    }
  }

  return envSchema.parse(process.env);
}

export const config = createConfig();
