import IORedis from "ioredis";
import type { Logger } from "pino";
import { logger as defaultLogger } from "../logger";

export interface BotMessageStoreOptions {
  redisUrl: string;
  keyPrefix?: string;
  ttlSeconds?: number;
  logger?: Logger;
}

export class BotMessageStore {
  private redis: IORedis;
  private keyPrefix: string;
  private ttlSeconds: number;
  private logger: Logger;

  constructor(options: BotMessageStoreOptions) {
    this.redis = new IORedis(options.redisUrl, { maxRetriesPerRequest: null });
    this.keyPrefix = options.keyPrefix ?? "botmsg";
    this.ttlSeconds = options.ttlSeconds ?? 7 * 24 * 60 * 60;
    this.logger = (options.logger ?? defaultLogger).child({
      component: "bot-message-store",
    });
  }

  async recordSentMessage(input: {
    platform: string;
    selfId: string;
    messageId: string;
  }): Promise<void> {
    const { platform, selfId, messageId } = input;
    if (!platform || !selfId || !messageId) {
      return;
    }
    const key = this.buildKey(platform, selfId, messageId);
    try {
      await this.redis.set(key, "1", "EX", this.ttlSeconds);
    } catch (err) {
      this.logger.debug({ err, key }, "Failed to record bot message id");
    }
  }

  async isBotMessage(input: {
    platform: string;
    selfId: string;
    messageId: string;
  }): Promise<boolean> {
    const { platform, selfId, messageId } = input;
    if (!platform || !selfId || !messageId) {
      return false;
    }
    const key = this.buildKey(platform, selfId, messageId);
    try {
      const exists = await this.redis.exists(key);
      return exists === 1;
    } catch (err) {
      this.logger.debug({ err, key }, "Failed to check bot message id");
      return false;
    }
  }

  async close(): Promise<void> {
    await this.redis.quit();
  }

  private buildKey(
    platform: string,
    selfId: string,
    messageId: string,
  ): string {
    return `${this.keyPrefix}:${platform}:${selfId}:${messageId}`;
  }
}
