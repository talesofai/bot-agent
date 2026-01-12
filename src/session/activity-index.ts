import IORedis from "ioredis";
import type { Logger } from "pino";

export interface SessionActivityIndexOptions {
  redisUrl: string;
  logger: Logger;
  key?: string;
}

export interface SessionActivityKey {
  groupId: string;
  sessionId: string;
}

export class SessionActivityIndex {
  private redis: IORedis;
  private logger: Logger;
  private key: string;

  constructor(options: SessionActivityIndexOptions) {
    this.redis = new IORedis(options.redisUrl, {
      maxRetriesPerRequest: null,
    });
    this.logger = options.logger.child({ component: "session-activity-index" });
    this.key = options.key ?? "session:last-active";
  }

  async recordActivity(
    key: SessionActivityKey,
    timestampMs = Date.now(),
  ): Promise<void> {
    const member = this.encodeMember(key);
    await this.redis.zadd(this.key, timestampMs, member);
  }

  async fetchExpired(cutoffMs: number): Promise<SessionActivityKey[]> {
    const members = await this.redis.zrangebyscore(this.key, 0, cutoffMs);
    const decoded = members.map((member) => this.decodeMember(member));
    return decoded.filter(
      (entry): entry is SessionActivityKey => entry !== null,
    );
  }

  async remove(key: SessionActivityKey): Promise<void> {
    const member = this.encodeMember(key);
    await this.redis.zrem(this.key, member);
  }

  async close(): Promise<void> {
    await this.redis.quit();
  }

  private encodeMember(key: SessionActivityKey): string {
    return `${key.groupId}:${key.sessionId}`;
  }

  private decodeMember(member: string): SessionActivityKey | null {
    const [groupId, ...rest] = member.split(":");
    if (!groupId || rest.length === 0) {
      this.logger.warn({ member }, "Invalid session activity member");
      return null;
    }
    return { groupId, sessionId: rest.join(":") };
  }
}
