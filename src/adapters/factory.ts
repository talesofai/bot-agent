/**
 * Adapter Factory
 *
 * Creates platform adapters based on configuration.
 */

import type { PlatformAdapter } from "../types/platform";
import type { AppConfig } from "../config";
import { QQAdapterPool } from "./qq/index";

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
      // TODO: Implement Discord adapter
      throw new Error("Discord adapter not implemented yet");
    default:
      throw new Error(`Unknown platform: ${config.PLATFORM}`);
  }
}
