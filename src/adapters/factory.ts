import type { AppConfig } from "../config";
import type { PlatformAdapter } from "../types/platform";
import { DiscordAdapter } from "./discord";
import { QQAdapterPool } from "./qq";

export function createPlatformAdapters(config: AppConfig): PlatformAdapter[] {
  const adapters: PlatformAdapter[] = [];
  for (const platform of config.platforms) {
    if (platform === "qq") {
      adapters.push(
        new QQAdapterPool({
          redisUrl: config.REDIS_URL,
          registryPrefix: config.LLBOT_REGISTRY_PREFIX,
        }),
      );
    } else if (platform === "discord") {
      adapters.push(
        new DiscordAdapter({
          token: config.DISCORD_TOKEN,
        }),
      );
    }
  }
  return adapters;
}
