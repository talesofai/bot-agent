import IORedis from "ioredis";
import type { SessionEvent } from "../types/platform";

export interface SessionBufferStoreOptions {
  redisUrl: string;
  keyPrefix?: string;
  pendingKeyPrefix?: string;
  pendingTtlSeconds?: number;
}

export interface SessionBufferKey {
  botId: string;
  groupId: string;
  sessionId: string;
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

  async append(key: SessionBufferKey, message: SessionEvent): Promise<void> {
    const redisKey = this.bufferKey(key);
    await this.redis.rpush(redisKey, JSON.stringify(message));
  }

  async drain(key: SessionBufferKey): Promise<SessionEvent[]> {
    const redisKey = this.bufferKey(key);
    const raw = (await this.redis.eval(
      "local entries = redis.call('LRANGE', KEYS[1], 0, -1); if #entries > 0 then redis.call('DEL', KEYS[1]); end; return entries;",
      1,
      redisKey,
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

  async markPending(key: SessionBufferKey): Promise<void> {
    const redisKey = this.pendingKey(key);
    await this.redis.set(redisKey, "1", "EX", this.pendingTtlSeconds);
  }

  async consumePending(key: SessionBufferKey): Promise<boolean> {
    const redisKey = this.pendingKey(key);
    const result = (await this.redis.eval(
      "local exists = redis.call('EXISTS', KEYS[1]); if exists == 1 then redis.call('DEL', KEYS[1]); end; return exists;",
      1,
      redisKey,
    )) as number;
    return result === 1;
  }

  async close(): Promise<void> {
    await this.redis.quit();
  }

  private bufferKey(key: SessionBufferKey): string {
    return `${this.keyPrefix}:${key.botId}:${key.groupId}:${key.sessionId}`;
  }

  private pendingKey(key: SessionBufferKey): string {
    return `${this.pendingKeyPrefix}:${key.botId}:${key.groupId}:${key.sessionId}`;
  }
}
