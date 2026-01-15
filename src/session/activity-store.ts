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

export class SessionActivityStore {
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

  async fetchExpired(cutoffMs: number): Promise<SessionKey[]> {
    const members = await this.redis.zrangebyscore(this.key, 0, cutoffMs);
    const decoded: SessionKey[] = [];
    const invalidMembers: string[] = [];
    for (const member of members) {
      const entry = this.decodeMember(member);
      if (entry) {
        decoded.push(entry);
      } else {
        invalidMembers.push(member);
      }
    }
    if (invalidMembers.length > 0) {
      try {
        await this.redis.zrem(this.key, ...invalidMembers);
      } catch (err) {
        this.logger.warn(
          { err, count: invalidMembers.length },
          "Failed to remove invalid session activity members",
        );
      }
    }
    return decoded;
  }

  async remove(key: SessionKey): Promise<void> {
    const member = this.encodeMember(key);
    await this.redis.zrem(this.key, member);
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

  private decodeMember(member: string): SessionKey | null {
    const [botId, groupId, ...rest] = member.split(":");
    if (!botId || !groupId || rest.length === 0) {
      this.logger.warn({ member }, "Invalid session activity member");
      return null;
    }
    const sessionId = rest.join(":");
    if (
      !isSafePathSegment(botId) ||
      !isSafePathSegment(groupId) ||
      !isSafePathSegment(sessionId)
    ) {
      this.logger.warn({ member }, "Unsafe session activity member");
      return null;
    }
    return { botId, groupId, sessionId };
  }
}
