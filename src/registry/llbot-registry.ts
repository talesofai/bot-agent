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
  refreshIntervalSec?: number;
  ttlSec?: number;
  logger?: Logger;
}

export type RegistryUpdateHandler = (
  entries: Map<string, LlbotRegistryEntry>,
) => void | Promise<void>;

export class LlbotRegistry {
  private redis: IORedis;
  private prefix: string;
  private logger: Logger;
  private refreshIntervalSec: number;
  private ttlSec: number | null;
  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  private refreshInFlight = false;
  private onUpdate: RegistryUpdateHandler | null = null;

  constructor(options: LlbotRegistryOptions) {
    this.redis = new IORedis(options.redisUrl, { maxRetriesPerRequest: null });
    this.prefix = options.prefix;
    this.refreshIntervalSec = options.refreshIntervalSec ?? 10;
    this.ttlSec = options.ttlSec ?? null;
    this.logger = (options.logger ?? defaultLogger).child({
      component: "llbot-registry",
    });
  }

  async start(handler: RegistryUpdateHandler): Promise<void> {
    this.onUpdate = handler;
    await this.refresh();
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
    }
    this.refreshTimer = setInterval(() => {
      void this.refresh();
    }, this.refreshIntervalSec * 1000);
  }

  async stop(): Promise<void> {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
    await this.redis.quit();
  }

  private async refresh(): Promise<void> {
    if (this.refreshInFlight) {
      return;
    }
    this.refreshInFlight = true;
    try {
      const entries = await this.listEntries();
      if (this.onUpdate) {
        await this.onUpdate(entries);
      }
    } catch (err) {
      this.logger.error({ err }, "Failed to refresh llbot registry");
    } finally {
      this.refreshInFlight = false;
    }
  }

  private async listEntries(): Promise<Map<string, LlbotRegistryEntry>> {
    const entries = new Map<string, LlbotRegistryEntry>();
    const keyPrefix = `${this.prefix}:`;
    let cursor = "0";

    do {
      const [nextCursor, keys] = await this.redis.scan(
        cursor,
        "MATCH",
        `${keyPrefix}*`,
        "COUNT",
        "100",
      );
      cursor = nextCursor;
      if (keys.length === 0) {
        continue;
      }
      const values = await this.redis.mget(keys);
      for (let i = 0; i < keys.length; i += 1) {
        const key = keys[i];
        const value = values[i];
        if (!value) {
          continue;
        }
        const botId = key.slice(keyPrefix.length);
        const entry = this.parseEntry(botId, value);
        if (entry && this.isEntryFresh(entry)) {
          entries.set(botId, entry);
        }
      }
    } while (cursor !== "0");

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
    const platform =
      typeof data.platform === "string" ? data.platform : "qq";
    const lastSeenAt =
      typeof data.lastSeenAt === "string" ? data.lastSeenAt : undefined;

    return { botId, wsUrl, platform, lastSeenAt };
  }

  private isEntryFresh(entry: LlbotRegistryEntry): boolean {
    if (!this.ttlSec) {
      return true;
    }
    if (!entry.lastSeenAt) {
      this.logger.warn(
        { botId: entry.botId },
        "Registry entry missing lastSeenAt",
      );
      return false;
    }
    const timestamp = Date.parse(entry.lastSeenAt);
    if (Number.isNaN(timestamp)) {
      this.logger.warn(
        { botId: entry.botId, lastSeenAt: entry.lastSeenAt },
        "Registry entry has invalid lastSeenAt",
      );
      return false;
    }
    const ageMs = Date.now() - timestamp;
    if (ageMs > this.ttlSec * 1000) {
      return false;
    }
    return true;
  }
}
