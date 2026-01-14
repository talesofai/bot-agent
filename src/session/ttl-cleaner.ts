import { rm, readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { Logger } from "pino";

import { getConfig } from "../config";
import type { SessionMeta, SessionStatus } from "../types/session";
import { SessionActivityStore, type SessionKey } from "./activity-store";
import { isSafePathSegment } from "../utils/path";

export interface SessionTtlCleanerOptions {
  dataDir?: string;
  logger: Logger;
  ttlMs?: number;
  redisUrl?: string | null;
}

export class SessionTtlCleaner {
  private dataDir: string;
  private logger: Logger;
  private ttlMs: number;
  private activityIndex: SessionActivityStore | null;

  constructor(options: SessionTtlCleanerOptions) {
    this.dataDir = options.dataDir ?? getConfig().GROUPS_DATA_DIR;
    this.logger = options.logger.child({ component: "session-ttl-cleaner" });
    this.ttlMs = options.ttlMs ?? 30 * 24 * 60 * 60 * 1000;
    const redisUrl =
      options.redisUrl === undefined ? getConfig().REDIS_URL : options.redisUrl;
    this.activityIndex = redisUrl
      ? new SessionActivityStore({
          redisUrl,
          logger: this.logger,
        })
      : null;
  }

  async cleanup(): Promise<number> {
    const now = Date.now();
    const cutoffMs = now - this.ttlMs;
    let removed = 0;
    const removedKeys = new Set<string>();

    if (this.activityIndex) {
      removed += await this.cleanupFromIndex(cutoffMs, removedKeys);
    }

    const groupEntries = await this.readDirSafe(this.dataDir);
    for (const groupEntry of groupEntries) {
      if (!groupEntry.isDirectory() || groupEntry.name.startsWith(".")) {
        continue;
      }
      const groupId = groupEntry.name;
      if (!isSafePathSegment(groupId)) {
        this.logger.warn({ groupId }, "Skipping unsafe group directory");
        continue;
      }
      const sessionsDir = join(this.dataDir, groupId, "sessions");
      const sessionEntries = await this.readDirSafe(sessionsDir);
      for (const sessionEntry of sessionEntries) {
        if (!sessionEntry.isDirectory()) {
          continue;
        }
        const sessionId = sessionEntry.name;
        if (!isSafePathSegment(sessionId)) {
          this.logger.warn(
            { groupId, sessionId },
            "Skipping unsafe session directory",
          );
          continue;
        }
        const sessionKey = this.buildSessionKey(groupId, sessionId);
        if (removedKeys.has(sessionKey)) {
          continue;
        }
        const sessionPath = join(sessionsDir, sessionId);
        const metaPath = join(sessionPath, "meta.json");
        const { status, lastActiveMs } = await this.readSessionState(
          metaPath,
          sessionPath,
        );
        if (lastActiveMs === null) {
          this.logger.warn(
            { groupId, sessionId },
            "Skipping session without last active timestamp",
          );
          continue;
        }
        const ageMs = now - lastActiveMs;
        if (ageMs <= this.ttlMs) {
          continue;
        }
        if (status === "running") {
          this.logger.warn(
            { groupId, sessionId, ageMs },
            "Removing stale running session",
          );
        }
        if (await this.removeSession(groupId, sessionId, sessionPath)) {
          removedKeys.add(sessionKey);
          removed += 1;
        }
      }
    }

    if (removed > 0) {
      this.logger.info({ removed }, "Session TTL cleanup removed sessions");
    }

    return removed;
  }

  async close(): Promise<void> {
    if (!this.activityIndex) {
      return;
    }
    await this.activityIndex.close();
    this.activityIndex = null;
  }

  private async readMeta(metaPath: string): Promise<SessionMeta | null> {
    try {
      const raw = await readFile(metaPath, "utf-8");
      return JSON.parse(raw) as SessionMeta;
    } catch {
      return null;
    }
  }

  private async readSessionState(
    metaPath: string,
    sessionPath: string,
  ): Promise<{ status: SessionStatus | null; lastActiveMs: number | null }> {
    const meta = await this.readMeta(metaPath);
    let lastActiveMs: number | null = null;
    if (meta?.updatedAt) {
      const parsed = Date.parse(meta.updatedAt);
      if (!Number.isNaN(parsed)) {
        lastActiveMs = parsed;
      }
    }
    try {
      if (lastActiveMs === null) {
        const stats = await stat(sessionPath);
        lastActiveMs = stats.mtimeMs;
      }
    } catch {
      return { status: meta?.status ?? null, lastActiveMs };
    }
    return { status: meta?.status ?? null, lastActiveMs };
  }

  private async readDirSafe(path: string) {
    try {
      return await readdir(path, { withFileTypes: true });
    } catch {
      return [];
    }
  }

  private async cleanupFromIndex(
    cutoffMs: number,
    removedKeys: Set<string>,
  ): Promise<number> {
    if (!this.activityIndex) {
      return 0;
    }
    let removed = 0;
    let expired: SessionKey[] = [];
    try {
      expired = await this.activityIndex.fetchExpired(cutoffMs);
    } catch (err) {
      this.logger.warn({ err }, "Failed to read expired session index");
      return 0;
    }
    for (const entry of expired) {
      if (
        !isSafePathSegment(entry.groupId) ||
        !isSafePathSegment(entry.sessionId)
      ) {
        this.logger.warn({ entry }, "Skipping unsafe session entry from index");
        await this.removeIndexEntry(entry);
        continue;
      }
      const sessionKey = this.buildSessionKey(entry.groupId, entry.sessionId);
      if (removedKeys.has(sessionKey)) {
        continue;
      }
      if (await this.removeSession(entry.groupId, entry.sessionId)) {
        removedKeys.add(sessionKey);
        removed += 1;
      }
    }
    return removed;
  }

  private async removeSession(
    groupId: string,
    sessionId: string,
    sessionPath = join(this.dataDir, groupId, "sessions", sessionId),
  ): Promise<boolean> {
    try {
      await rm(sessionPath, { recursive: true, force: true });
    } catch (err) {
      this.logger.warn(
        { err, groupId, sessionId },
        "Failed to remove stale session directory",
      );
      return false;
    }
    await this.removeIndexEntry({ groupId, sessionId });
    return true;
  }

  private buildSessionKey(groupId: string, sessionId: string): string {
    return `${groupId}:${sessionId}`;
  }

  private async removeIndexEntry(key: SessionKey): Promise<void> {
    if (!this.activityIndex) {
      return;
    }
    try {
      await this.activityIndex.remove(key);
    } catch (err) {
      this.logger.warn({ err, key }, "Failed to remove session index entry");
    }
  }
}
