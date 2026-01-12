import { constants } from "node:fs";
import { access, readdir, rm, stat, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Logger } from "pino";

import { getConfig } from "../config";
import type { SessionMeta } from "../types/session";

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

    for await (const session of this.scanSessions()) {
      if (!(await this.isExpired(session, now))) {
        continue;
      }
      await rm(session.sessionPath, { recursive: true, force: true });
      removed += 1;
    }

    if (removed > 0) {
      this.logger.info({ removed }, "Session TTL cleanup removed sessions");
    }

    return removed;
  }

  private async isExpired(session: SessionScanEntry, now: number): Promise<boolean> {
    if (await this.exists(session.lockPath)) {
      return false;
    }
    if (session.meta?.status === "running") {
      return false;
    }
    const lastActive = await this.resolveLastActive(session.meta, session.sessionPath);
    return now - lastActive > this.ttlMs;
  }

  private async *scanSessions(): AsyncGenerator<SessionScanEntry> {
    const groupDirs = await this.listDirs(this.dataDir);
    for (const groupId of groupDirs) {
      const sessionsPath = join(this.dataDir, groupId, "sessions");
      if (!(await this.exists(sessionsPath))) {
        continue;
      }
      const sessionDirs = await this.listDirs(sessionsPath);
      for (const sessionId of sessionDirs) {
        const sessionPath = join(sessionsPath, sessionId);
        const lockPath = join(sessionPath, ".runtime.lock");
        const metaPath = join(sessionPath, "meta.json");
        const meta = await this.readMeta(metaPath);
        yield { sessionPath, lockPath, meta };
      }
    }
  }

  private async resolveLastActive(
    meta: SessionMeta | null,
    sessionPath: string,
  ): Promise<number> {
    const timestamp = meta?.updatedAt ?? meta?.createdAt;
    if (timestamp) {
      const parsed = Date.parse(timestamp);
      if (!Number.isNaN(parsed)) {
        return parsed;
      }
    }
    try {
      const stats = await stat(sessionPath);
      return stats.mtimeMs;
    } catch {
      return Date.now();
    }
  }

  private async readMeta(metaPath: string): Promise<SessionMeta | null> {
    try {
      const raw = await readFile(metaPath, "utf-8");
      return JSON.parse(raw) as SessionMeta;
    } catch {
      return null;
    }
  }

  private async listDirs(parent: string): Promise<string[]> {
    try {
      const entries = await readdir(parent, { withFileTypes: true });
      return entries
        .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
        .map((entry) => entry.name);
    } catch {
      return [];
    }
  }

  private async exists(targetPath: string): Promise<boolean> {
    try {
      await access(targetPath, constants.F_OK);
      return true;
    } catch {
      return false;
    }
  }
}

interface SessionScanEntry {
  sessionPath: string;
  lockPath: string;
  meta: SessionMeta | null;
}
