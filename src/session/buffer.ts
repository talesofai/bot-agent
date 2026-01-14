import IORedis from "ioredis";
import type { SessionEvent } from "../types/platform";

export interface SessionBufferStoreOptions {
  redisUrl: string;
  keyPrefix?: string;
  pendingKeyPrefix?: string;
  pendingTtlSeconds?: number;
}

export class SessionBufferStore {
  private redis: IORedis;
  private keyPrefix: string;
  private pendingKeyPrefix: string;
  private pendingTtlSeconds: number;

  constructor(options: SessionBufferStoreOptions) {
    this.redis = new IORedis(options.redisUrl, { maxRetriesPerRequest: null });
    this.keyPrefix = options.keyPrefix ?? "session:buffer";
    this.pendingKeyPrefix = options.pendingKeyPrefix ?? "session:pending";
    this.pendingTtlSeconds = options.pendingTtlSeconds ?? 60;
  }

  async append(sessionId: string, message: SessionEvent): Promise<void> {
    const key = this.bufferKey(sessionId);
    await this.redis.rpush(key, JSON.stringify(message));
  }

  async drain(sessionId: string): Promise<SessionEvent[]> {
    const key = this.bufferKey(sessionId);
    const raw = (await this.redis.eval(
      "local entries = redis.call('LRANGE', KEYS[1], 0, -1); if #entries > 0 then redis.call('DEL', KEYS[1]); end; return entries;",
      1,
      key,
    )) as string[];
    if (!raw || raw.length === 0) {
      return [];
    }
    return raw
      .map((entry) => {
        try {
          return JSON.parse(entry) as SessionEvent;
        } catch {
          return null;
        }
      })
      .filter((entry): entry is SessionEvent => entry !== null);
  }

  async isLocked(lockKey: string): Promise<boolean> {
    const exists = await this.redis.exists(lockKey);
    return exists > 0;
  }

  async markPending(sessionId: string): Promise<void> {
    const key = this.pendingKey(sessionId);
    await this.redis.set(key, "1", "EX", this.pendingTtlSeconds);
  }

  async consumePending(sessionId: string): Promise<boolean> {
    const key = this.pendingKey(sessionId);
    const result = (await this.redis.eval(
      "local exists = redis.call('EXISTS', KEYS[1]); if exists == 1 then redis.call('DEL', KEYS[1]); end; return exists;",
      1,
      key,
    )) as number;
    return result === 1;
  }

  async close(): Promise<void> {
    await this.redis.quit();
  }

  private bufferKey(sessionId: string): string {
    return `${this.keyPrefix}:${sessionId}`;
  }

  private pendingKey(sessionId: string): string {
    return `${this.pendingKeyPrefix}:${sessionId}`;
  }
}
