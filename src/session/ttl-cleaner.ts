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
          removed += 1;
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
    try {
      const stats = await stat(sessionPath);
      return { status: meta?.status ?? null, lastActiveMs: stats.mtimeMs };
    } catch {
      return { status: meta?.status ?? null, lastActiveMs: null };
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
    return true;
  }
}
