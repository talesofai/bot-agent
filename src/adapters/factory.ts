/**
 * Adapter Factory
 *
 * Creates platform adapters based on configuration.
 */

import type { PlatformAdapter } from "../types/platform";
import type { AppConfig } from "../config";
import { QQAdapterPool } from "./qq/index";
import { DiscordAdapter } from "./discord";

/**
 * Creates a platform adapter based on the provided configuration.
 */
export function createAdapter(config: AppConfig): PlatformAdapter {
  switch (config.PLATFORM) {
    case "qq":
      return new QQAdapterPool({
        redisUrl: config.REDIS_URL,
        registryPrefix: config.LLBOT_REGISTRY_PREFIX,
        refreshIntervalSec: config.LLBOT_REGISTRY_REFRESH_SEC,
      });
    case "discord":
      return new DiscordAdapter({
        token: config.DISCORD_TOKEN,
      });
    default:
      throw new Error(`Unknown platform: ${config.PLATFORM}`);
  }
}
