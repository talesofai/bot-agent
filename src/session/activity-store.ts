import IORedis from "ioredis";
import type { Logger } from "pino";
import { isSafePathSegment } from "../utils/path";

export interface SessionActivityStoreOptions {
  redisUrl: string;
  logger: Logger;
  key?: string;
}

export interface SessionKey {
  botId: string;
  groupId: string;
  sessionId: string;
}

export interface SessionActivityIndex {
  recordActivity(key: SessionKey, timestampMs?: number): Promise<void>;
  close(): Promise<void>;
}

export class SessionActivityStore implements SessionActivityIndex {
  private redis: IORedis;
  private logger: Logger;
  private key: string;

  constructor(options: SessionActivityStoreOptions) {
    this.redis = new IORedis(options.redisUrl, {
      maxRetriesPerRequest: null,
    });
    this.logger = options.logger.child({ component: "session-activity-store" });
    this.key = options.key ?? "session:last-active";
  }

  async recordActivity(
    key: SessionKey,
    timestampMs = Date.now(),
  ): Promise<void> {
    const member = this.encodeMember(key);
    await this.redis.zadd(this.key, timestampMs, member);
  }

  async close(): Promise<void> {
    await this.redis.quit();
  }

  private encodeMember(key: SessionKey): string {
    if (
      !isSafePathSegment(key.botId) ||
      !isSafePathSegment(key.groupId) ||
      !isSafePathSegment(key.sessionId)
    ) {
      this.logger.warn({ key }, "Unsafe session activity key");
      throw new Error("Unsafe session activity key");
    }
    return `${key.botId}:${key.groupId}:${key.sessionId}`;
  }
}
