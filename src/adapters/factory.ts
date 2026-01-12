/**
 * Adapter Factory
 *
 * Creates platform adapters based on configuration.
 */

import type { PlatformAdapter } from "../types/platform";
import type { AppConfig } from "../config";
import { QQAdapter } from "./qq/index";

export type PlatformType = "qq" | "discord";

/**
 * Creates a platform adapter based on the provided configuration.
 */
export function createAdapter(config: AppConfig): PlatformAdapter {
  switch (config.PLATFORM) {
    case "qq":
      if (!config.MILKY_URL) {
        throw new Error("MILKY_URL is required for QQ platform");
      }
      return new QQAdapter({ url: config.MILKY_URL });
    case "discord":
      // TODO: Implement Discord adapter
      throw new Error("Discord adapter not implemented yet");
    default:
      throw new Error(`Unknown platform: ${config.PLATFORM}`);
  }
}
