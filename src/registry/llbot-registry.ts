import IORedis from "ioredis";
import type { Logger } from "pino";
import { logger as defaultLogger } from "../logger";

export interface LlbotRegistryEntry {
  botId: string;
  wsUrl: string;
  platform: string;
  lastSeenAt?: string;
}

export interface LlbotRegistryOptions {
  redisUrl: string;
  prefix: string;
  indexKey?: string;
  updateChannel?: string;
  logger?: Logger;
}

export type RegistryUpdateHandler = (
  entries: Map<string, LlbotRegistryEntry>,
) => void | Promise<void>;

export class LlbotRegistry {
  private redis: IORedis;
  private subscriber: IORedis;
  private prefix: string;
  private indexKey: string;
  private updateChannel: string;
  private logger: Logger;
  private refreshInFlight = false;
  private refreshQueued = false;
  private onUpdate: RegistryUpdateHandler | null = null;

  constructor(options: LlbotRegistryOptions) {
    this.redis = new IORedis(options.redisUrl, { maxRetriesPerRequest: null });
    this.subscriber = new IORedis(options.redisUrl, {
      maxRetriesPerRequest: null,
    });
    this.prefix = options.prefix;
    this.indexKey = options.indexKey ?? `${options.prefix}:index`;
    this.updateChannel = options.updateChannel ?? `${options.prefix}:updates`;
    this.logger = (options.logger ?? defaultLogger).child({
      component: "llbot-registry",
    });
  }

  async start(handler: RegistryUpdateHandler): Promise<void> {
    this.onUpdate = handler;
    await this.refresh();
    this.subscriber.on("message", (_channel, message) => {
      if (message === "refresh") {
        void this.refresh();
      }
    });
    this.subscriber.on("pmessage", (_pattern, _channel, message) => {
      if (message === "set" || message === "expired") {
        void this.refresh();
      }
    });
    await this.subscriber.subscribe(this.updateChannel);
    await this.subscriber.psubscribe(`__keyspace@*__:${this.prefix}:*`);
  }

  async stop(): Promise<void> {
    this.subscriber.removeAllListeners("message");
    this.subscriber.removeAllListeners("pmessage");
    await this.subscriber.quit();
    await this.redis.quit();
  }

  private async refresh(): Promise<void> {
    if (this.refreshInFlight) {
      this.refreshQueued = true;
      return;
    }
    this.refreshInFlight = true;
    try {
      do {
        this.refreshQueued = false;
        const entries = await this.listEntries();
        if (this.onUpdate) {
          await this.onUpdate(entries);
        }
      } while (this.refreshQueued);
    } catch (err) {
      this.logger.error({ err }, "Failed to refresh llbot registry");
    } finally {
      this.refreshInFlight = false;
    }
  }

  private async listEntries(): Promise<Map<string, LlbotRegistryEntry>> {
    const entries = new Map<string, LlbotRegistryEntry>();
    const keys = await this.redis.smembers(this.indexKey);
    if (keys.length === 0) {
      return entries;
    }
    const values = await this.redis.mget(keys);
    const staleKeys: string[] = [];
    const keyPrefix = `${this.prefix}:`;
    for (let i = 0; i < keys.length; i += 1) {
      const key = keys[i];
      if (!key.startsWith(keyPrefix)) {
        staleKeys.push(key);
        continue;
      }
      const value = values[i];
      if (!value) {
        staleKeys.push(key);
        continue;
      }
      const botId = key.slice(keyPrefix.length);
      const entry = this.parseEntry(botId, value);
      if (entry) {
        entries.set(botId, entry);
      }
    }
    if (staleKeys.length > 0) {
      await this.redis.srem(this.indexKey, ...staleKeys);
    }

    return entries;
  }

  private parseEntry(botId: string, raw: string): LlbotRegistryEntry | null {
    let data: Record<string, unknown> = {};
    try {
      data = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      data = { wsUrl: raw };
    }
    const wsUrl = typeof data.wsUrl === "string" ? data.wsUrl : raw;
    if (!wsUrl) {
      this.logger.warn({ botId, raw }, "Registry entry missing wsUrl");
      return null;
    }
    const platform = typeof data.platform === "string" ? data.platform : "qq";
    const lastSeenAt =
      typeof data.lastSeenAt === "string" ? data.lastSeenAt : undefined;

    return { botId, wsUrl, platform, lastSeenAt };
  }
}
