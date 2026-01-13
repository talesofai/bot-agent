import { rm, readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { Logger } from "pino";

import { getConfig } from "../config";
import type { SessionMeta, SessionStatus } from "../types/session";
import { SessionActivityStore, type SessionKey } from "./activity-store";

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
    const redisUrl = options.redisUrl ?? getConfig().REDIS_URL;
    this.activityIndex = redisUrl
      ? new SessionActivityStore({
          redisUrl,
          logger: this.logger,
        })
      : null;
  }

  async cleanup(): Promise<number> {
    const now = Date.now();
    let removed = 0;

    try {
      const groupEntries = await this.readDirSafe(this.dataDir);
      for (const groupEntry of groupEntries) {
        if (!groupEntry.isDirectory() || groupEntry.name.startsWith(".")) {
          continue;
        }
        const groupId = groupEntry.name;
        const sessionsDir = join(this.dataDir, groupId, "sessions");
        const sessionEntries = await this.readDirSafe(sessionsDir);
        for (const sessionEntry of sessionEntries) {
          if (!sessionEntry.isDirectory()) {
            continue;
          }
          const sessionId = sessionEntry.name;
          const sessionPath = join(sessionsDir, sessionId);
          const metaPath = join(sessionPath, "meta.json");
          const { status, lastActiveMs } = await this.readSessionState(
            metaPath,
            sessionPath,
          );
          if (status === "running") {
            continue;
          }
          if (lastActiveMs === null) {
            this.logger.warn(
              { groupId, sessionId },
              "Skipping session without last active timestamp",
            );
            continue;
          }
          if (now - lastActiveMs <= this.ttlMs) {
            continue;
          }
          await rm(sessionPath, { recursive: true, force: true });
          await this.removeIndexEntry({ groupId, sessionId });
          removed += 1;
        }
      }
    } finally {
      if (this.activityIndex) {
        await this.activityIndex.close();
      }
    }

    if (removed > 0) {
      this.logger.info({ removed }, "Session TTL cleanup removed sessions");
    }

    return removed;
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
