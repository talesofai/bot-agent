import IORedis from "ioredis";
import type { SessionEvent } from "../types/platform";

export interface SessionBufferStoreOptions {
  redisUrl: string;
  keyPrefix?: string;
  gateKeyPrefix?: string;
  gateTtlSeconds?: number;
}

export interface SessionBufferKey {
  botId: string;
  groupId: string;
  sessionId: string;
}

export class SessionBufferStore {
  private redis: IORedis;
  private keyPrefix: string;
  private gateKeyPrefix: string;
  private gateTtlSeconds: number;

  constructor(options: SessionBufferStoreOptions) {
    this.redis = new IORedis(options.redisUrl, { maxRetriesPerRequest: null });
    this.keyPrefix = options.keyPrefix ?? "session:buffer";
    this.gateKeyPrefix = options.gateKeyPrefix ?? "session:gate";
    this.gateTtlSeconds = options.gateTtlSeconds ?? 60;
  }

  getGateTtlSeconds(): number {
    return this.gateTtlSeconds;
  }

  async append(key: SessionBufferKey, message: SessionEvent): Promise<void> {
    const redisKey = this.bufferKey(key);
    await this.redis.rpush(redisKey, JSON.stringify(message));
  }

  async appendAndRequestJob(
    key: SessionBufferKey,
    message: SessionEvent,
    token: string,
  ): Promise<string | null> {
    const redisKey = this.bufferKey(key);
    const gateKey = this.gateKey(key);
    const raw = JSON.stringify(message);
    const result = (await this.redis.eval(
      "redis.call('RPUSH', KEYS[1], ARGV[1]); local ok = redis.call('SET', KEYS[2], ARGV[2], 'NX', 'EX', ARGV[3]); if ok then return ARGV[2]; end; return nil;",
      2,
      redisKey,
      gateKey,
      raw,
      token,
      String(this.gateTtlSeconds),
    )) as string | null;
    return result ?? null;
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

  async claimGate(key: SessionBufferKey, token: string): Promise<boolean> {
    const gateKey = this.gateKey(key);
    const result = (await this.redis.eval(
      "local gate = redis.call('GET', KEYS[1]); if not gate then redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[2]); return 1; end; if gate == ARGV[1] then redis.call('EXPIRE', KEYS[1], ARGV[2]); return 1; end; return 0;",
      1,
      gateKey,
      token,
      String(this.gateTtlSeconds),
    )) as number;
    return result === 1;
  }

  async refreshGate(key: SessionBufferKey, token: string): Promise<boolean> {
    const gateKey = this.gateKey(key);
    const result = (await this.redis.eval(
      "local gate = redis.call('GET', KEYS[1]); if gate == ARGV[1] then redis.call('EXPIRE', KEYS[1], ARGV[2]); return 1; end; return 0;",
      1,
      gateKey,
      token,
      String(this.gateTtlSeconds),
    )) as number;
    return result === 1;
  }

  async tryReleaseGate(key: SessionBufferKey, token: string): Promise<boolean> {
    const redisKey = this.bufferKey(key);
    const gateKey = this.gateKey(key);
    const result = (await this.redis.eval(
      "if redis.call('LLEN', KEYS[1]) ~= 0 then return 0; end; local gate = redis.call('GET', KEYS[2]); if not gate then return 1; end; if gate == ARGV[1] then redis.call('DEL', KEYS[2]); return 1; end; return 0;",
      2,
      redisKey,
      gateKey,
      token,
    )) as number;
    return result === 1;
  }

  async releaseGate(key: SessionBufferKey, token: string): Promise<boolean> {
    const gateKey = this.gateKey(key);
    const result = (await this.redis.eval(
      "local gate = redis.call('GET', KEYS[1]); if gate == ARGV[1] then redis.call('DEL', KEYS[1]); return 1; end; return 0;",
      1,
      gateKey,
      token,
    )) as number;
    return result === 1;
  }

  async close(): Promise<void> {
    await this.redis.quit();
  }

  private bufferKey(key: SessionBufferKey): string {
    return `${this.keyPrefix}:${key.botId}:${key.groupId}:${key.sessionId}`;
  }

  private gateKey(key: SessionBufferKey): string {
    return `${this.gateKeyPrefix}:${key.botId}:${key.groupId}:${key.sessionId}`;
  }
}
