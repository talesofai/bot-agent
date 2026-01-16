import { rm, readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { Logger } from "pino";

import { getConfig } from "../config";
import type { SessionMeta, SessionStatus } from "../types/session";
import { isSafePathSegment } from "../utils/path";

export interface SessionTtlCleanerOptions {
  dataDir?: string;
  logger: Logger;
  ttlMs?: number;
}

export class SessionTtlCleaner {
  private dataDir: string;
  private logger: Logger;
  private ttlMs: number;

  constructor(options: SessionTtlCleanerOptions) {
    this.dataDir = options.dataDir ?? getConfig().GROUPS_DATA_DIR;
    this.logger = options.logger.child({ component: "session-ttl-cleaner" });
    this.ttlMs = options.ttlMs ?? 30 * 24 * 60 * 60 * 1000;
  }

  async cleanup(): Promise<number> {
    const now = Date.now();
    let removed = 0;

    const sessionsRoot = join(this.dataDir, "sessions");
    const botEntries = await this.readDirSafe(sessionsRoot);
    for (const botEntry of botEntries) {
      if (!botEntry.isDirectory() || botEntry.name.startsWith(".")) {
        continue;
      }
      const botId = botEntry.name;
      if (!isSafePathSegment(botId)) {
        this.logger.warn({ botId }, "Skipping unsafe bot directory");
        continue;
      }
      const userEntries = await this.readDirSafe(join(sessionsRoot, botId));
      for (const userEntry of userEntries) {
        if (!userEntry.isDirectory()) {
          continue;
        }
        const userId = userEntry.name;
        if (!isSafePathSegment(userId)) {
          this.logger.warn({ botId, userId }, "Skipping unsafe user directory");
          continue;
        }
        const sessionEntries = await this.readDirSafe(
          join(sessionsRoot, botId, userId),
        );
        for (const sessionEntry of sessionEntries) {
          if (!sessionEntry.isDirectory()) {
            continue;
          }
          const sessionId = sessionEntry.name;
          if (!isSafePathSegment(sessionId)) {
            this.logger.warn(
              { botId, userId, sessionId },
              "Skipping unsafe session directory",
            );
            continue;
          }
          const sessionPath = join(sessionsRoot, botId, userId, sessionId);
          const metaPath = join(sessionPath, "meta.json");
          const { status, lastActiveMs } = await this.readSessionState(
            metaPath,
            sessionPath,
          );
          if (lastActiveMs === null) {
            this.logger.warn(
              { botId, userId, sessionId },
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
              { botId, userId, sessionId, ageMs },
              "Removing stale running session",
            );
          }
          if (await this.removeSession(botId, userId, sessionId, sessionPath)) {
            removed += 1;
          }
        }
      }
    }

    if (removed > 0) {
      this.logger.info({ removed }, "Session TTL cleanup removed sessions");
    }

    return removed;
  }

  async close(): Promise<void> {}

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
    const status = meta?.status ?? null;
    let lastActiveMs: number | null = null;

    if (meta?.updatedAt) {
      const parsed = Date.parse(meta.updatedAt);
      if (Number.isFinite(parsed)) {
        lastActiveMs = parsed;
      }
    }

    if (lastActiveMs === null) {
      lastActiveMs = await this.readMtimeMs(metaPath);
    }

    if (lastActiveMs === null) {
      lastActiveMs = await this.readMtimeMs(sessionPath);
    }

    return { status, lastActiveMs };
  }

  private async readMtimeMs(path: string): Promise<number | null> {
    try {
      const stats = await stat(path);
      return stats.mtimeMs;
    } catch {
      return null;
    }
  }

  private async readDirSafe(path: string) {
    try {
      return await readdir(path, { withFileTypes: true });
    } catch {
      return [];
    }
  }

  private async removeSession(
    botId: string,
    userId: string,
    sessionId: string,
    sessionPath = join(this.dataDir, "sessions", botId, userId, sessionId),
  ): Promise<boolean> {
    try {
      await rm(sessionPath, { recursive: true, force: true });
    } catch (err) {
      this.logger.warn(
        { err, botId, userId, sessionId },
        "Failed to remove stale session directory",
      );
      return false;
    }
    return true;
  }
}
