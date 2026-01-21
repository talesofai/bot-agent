import IORedis from "ioredis";
import type { Logger } from "pino";
import { logger as defaultLogger } from "../logger";
import { assertSafePathSegment } from "../utils/path";

export interface GroupRouteStoreOptions {
  redisUrl: string;
  keyPrefix?: string;
  routeTtlSeconds?: number;
  lockTtlSeconds?: number;
  logger?: Logger;
}

export type GroupRoute = {
  platform: string;
  selfId: string;
  channelId: string;
  updatedAt: string;
};

export class GroupRouteStore {
  private redis: IORedis;
  private keyPrefix: string;
  private routeTtlSeconds: number;
  private lockTtlSeconds: number;
  private logger: Logger;

  constructor(options: GroupRouteStoreOptions) {
    this.redis = new IORedis(options.redisUrl, { maxRetriesPerRequest: null });
    this.keyPrefix = options.keyPrefix ?? "group";
    this.routeTtlSeconds = options.routeTtlSeconds ?? 30 * 24 * 60 * 60;
    this.lockTtlSeconds = options.lockTtlSeconds ?? 27 * 60 * 60;
    this.logger = (options.logger ?? defaultLogger).child({
      component: "group-route-store",
    });
  }

  async recordRoute(input: {
    groupId: string;
    platform: string;
    selfId: string;
    channelId: string;
  }): Promise<void> {
    const { groupId, platform, selfId, channelId } = input;
    assertSafePathSegment(groupId, "groupId");
    const nowIso = new Date().toISOString();
    const payload: GroupRoute = {
      platform,
      selfId,
      channelId,
      updatedAt: nowIso,
    };
    const key = this.routeKey(groupId);
    try {
      await this.redis.set(
        key,
        JSON.stringify(payload),
        "EX",
        this.routeTtlSeconds,
      );
    } catch (err) {
      this.logger.debug({ err, key, groupId }, "Failed to record group route");
    }
  }

  async getRoute(groupId: string): Promise<GroupRoute | null> {
    assertSafePathSegment(groupId, "groupId");
    const key = this.routeKey(groupId);
    try {
      const raw = await this.redis.get(key);
      if (!raw) {
        return null;
      }
      const parsed = JSON.parse(raw) as unknown;
      if (!isGroupRoute(parsed)) {
        return null;
      }
      return parsed;
    } catch (err) {
      this.logger.debug({ err, key, groupId }, "Failed to load group route");
      return null;
    }
  }

  async acquireDailyPushLock(input: {
    groupId: string;
    date: string;
  }): Promise<boolean> {
    const { groupId, date } = input;
    assertSafePathSegment(groupId, "groupId");
    const safeDate = date.trim();
    if (!safeDate) {
      return false;
    }
    const key = this.pushLockKey(groupId, safeDate);
    try {
      const ok = await this.redis.set(
        key,
        "1",
        "EX",
        this.lockTtlSeconds,
        "NX",
      );
      return ok === "OK";
    } catch (err) {
      this.logger.debug({ err, key, groupId }, "Failed to acquire push lock");
      return false;
    }
  }

  async close(): Promise<void> {
    await this.redis.quit();
  }

  private routeKey(groupId: string): string {
    return `${this.keyPrefix}:route:${groupId}`;
  }

  private pushLockKey(groupId: string, date: string): string {
    return `${this.keyPrefix}:push:${groupId}:${date}`;
  }
}

function isGroupRoute(value: unknown): value is GroupRoute {
  if (!value || typeof value !== "object") {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record.platform === "string" &&
    typeof record.selfId === "string" &&
    typeof record.channelId === "string" &&
    typeof record.updatedAt === "string"
  );
}
