import IORedis from "ioredis";
import { createHash } from "node:crypto";
import type { Logger } from "pino";
import { logger as defaultLogger } from "../logger";

export interface BotMessageStoreOptions {
  redisUrl: string;
  keyPrefix?: string;
  ttlSeconds?: number;
  replySignatureTtlSeconds?: number;
  logger?: Logger;
}

export class BotMessageStore {
  private redis: IORedis;
  private keyPrefix: string;
  private ttlSeconds: number;
  private replySignatureTtlSeconds: number;
  private logger: Logger;

  constructor(options: BotMessageStoreOptions) {
    this.redis = new IORedis(options.redisUrl, { maxRetriesPerRequest: null });
    this.keyPrefix = options.keyPrefix ?? "botmsg";
    this.ttlSeconds = options.ttlSeconds ?? 7 * 24 * 60 * 60;
    this.replySignatureTtlSeconds = options.replySignatureTtlSeconds ?? 240;
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

  async hasReplySignature(input: {
    platform: string;
    selfId: string;
    replyTo: string;
    signature: string;
  }): Promise<boolean> {
    const { platform, selfId, replyTo, signature } = input;
    if (!platform || !selfId || !replyTo || !signature) {
      return false;
    }
    const key = this.buildReplySignatureKey(
      platform,
      selfId,
      replyTo,
      signature,
    );
    try {
      const exists = await this.redis.exists(key);
      return exists === 1;
    } catch (err) {
      this.logger.debug({ err, key }, "Failed to check reply signature");
      return false;
    }
  }

  async recordReplySignature(input: {
    platform: string;
    selfId: string;
    replyTo: string;
    signature: string;
  }): Promise<void> {
    const { platform, selfId, replyTo, signature } = input;
    if (!platform || !selfId || !replyTo || !signature) {
      return;
    }
    const key = this.buildReplySignatureKey(
      platform,
      selfId,
      replyTo,
      signature,
    );
    const ttlSeconds = Math.max(1, Math.floor(this.replySignatureTtlSeconds));
    try {
      await this.redis.set(key, "1", "EX", ttlSeconds);
    } catch (err) {
      this.logger.debug({ err, key }, "Failed to record reply signature");
    }
  }

  static hashSignature(input: string): string {
    const normalized = input.trim();
    if (!normalized) {
      return "";
    }
    return createHash("sha256").update(normalized).digest("hex").slice(0, 16);
  }

  private buildKey(
    platform: string,
    selfId: string,
    messageId: string,
  ): string {
    return `${this.keyPrefix}:${platform}:${selfId}:${messageId}`;
  }

  private buildReplySignatureKey(
    platform: string,
    selfId: string,
    replyTo: string,
    signature: string,
  ): string {
    return `${this.keyPrefix}:replysig:${platform}:${selfId}:${replyTo}:${signature}`;
  }
}
