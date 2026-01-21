import type { AppConfig } from "../config";
import type { PlatformAdapter } from "../types/platform";
import type { BotMessageStore } from "../store/bot-message-store";
import { DiscordAdapter } from "./discord";
import { QQAdapterPool } from "./qq";

export function createPlatformAdapters(
  config: AppConfig,
  options?: { botMessageStore?: BotMessageStore },
): PlatformAdapter[] {
  const adapters: PlatformAdapter[] = [
    new QQAdapterPool({
      redisUrl: config.REDIS_URL,
      registryPrefix: config.LLBOT_REGISTRY_PREFIX,
      botMessageStore: options?.botMessageStore,
    }),
  ];

  const discordToken = config.DISCORD_TOKEN?.trim();
  if (discordToken) {
    adapters.push(
      new DiscordAdapter({
        token: discordToken,
        applicationId: config.DISCORD_APPLICATION_ID,
        botMessageStore: options?.botMessageStore,
      }),
    );
  }
  return adapters;
}
