import type { AppConfig } from "../config";
import type { PlatformAdapter } from "../types/platform";
import { DiscordAdapter } from "./discord";
import { QQAdapterPool } from "./qq";

export function createPlatformAdapters(config: AppConfig): PlatformAdapter[] {
  const adapters: PlatformAdapter[] = [
    new QQAdapterPool({
      redisUrl: config.REDIS_URL,
      registryPrefix: config.LLBOT_REGISTRY_PREFIX,
    }),
  ];

  const discordToken = config.DISCORD_TOKEN?.trim();
  if (discordToken) {
    adapters.push(
      new DiscordAdapter({
        token: discordToken,
        applicationId: config.DISCORD_APPLICATION_ID,
      }),
    );
  }
  return adapters;
}
