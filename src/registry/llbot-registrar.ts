import IORedis, { type RedisKey } from "ioredis";
import type { Logger } from "pino";
import { logger as defaultLogger } from "../logger";

interface RedisClient {
  set(key: RedisKey, value: string): Promise<unknown>;
  set(key: RedisKey, value: string, mode: "EX", ttl: number): Promise<unknown>;
  sadd(key: RedisKey, member: string): Promise<unknown>;
  quit(): Promise<unknown>;
}

export interface LlbotRegistrarOptions {
  redisUrl: string;
  prefix: string;
  botId: string;
  wsUrl: string;
  platform: string;
  indexKey?: string;
  ttlSec?: number;
  refreshIntervalSec?: number;
  logger?: Logger;
  redis?: RedisClient;
}

export class LlbotRegistrar {
  private redis: RedisClient;
  private key: string;
  private payloadBase: { wsUrl: string; platform: string };
  private indexKey: string;
  private ttlSec: number | null;
  private refreshIntervalSec: number;
  private logger: Logger;
  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  private refreshInFlight = false;

  constructor(options: LlbotRegistrarOptions) {
    const ttlSec = options.ttlSec ?? 30;
    const refreshIntervalSec = options.refreshIntervalSec ?? 10;
    if (ttlSec && refreshIntervalSec >= ttlSec) {
      throw new Error("llbot registrar refresh interval must be less than ttl");
    }
    this.redis =
      options.redis ??
      new IORedis(options.redisUrl, { maxRetriesPerRequest: null });
    this.key = `${options.prefix}:${options.botId}`;
    this.indexKey = options.indexKey ?? `${options.prefix}:index`;
    this.payloadBase = { wsUrl: options.wsUrl, platform: options.platform };
    this.ttlSec = ttlSec;
    this.refreshIntervalSec = refreshIntervalSec;
    this.logger = (options.logger ?? defaultLogger).child({
      component: "llbot-registrar",
    });
  }

  async start(): Promise<void> {
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
      const payload = JSON.stringify({
        ...this.payloadBase,
        lastSeenAt: new Date().toISOString(),
      });
      if (this.ttlSec) {
        await this.redis.set(this.key, payload, "EX", this.ttlSec);
      } else {
        await this.redis.set(this.key, payload);
      }
      await this.redis.sadd(this.indexKey, this.key);
    } catch (err) {
      this.logger.error({ err }, "Failed to refresh llbot registry entry");
    } finally {
      this.refreshInFlight = false;
    }
  }
}
