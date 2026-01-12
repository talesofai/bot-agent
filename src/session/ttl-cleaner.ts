import { constants } from "node:fs";
import { access, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Logger } from "pino";

import { getConfig } from "../config";
import type { SessionMeta } from "../types/session";
import { SessionActivityIndex } from "./activity-index";

export interface SessionTtlCleanerOptions {
  dataDir?: string;
  logger: Logger;
  ttlMs?: number;
  redisUrl?: string;
}

export class SessionTtlCleaner {
  private dataDir: string;
  private logger: Logger;
  private ttlMs: number;
  private activityIndex: SessionActivityIndex;

  constructor(options: SessionTtlCleanerOptions) {
    this.dataDir = options.dataDir ?? getConfig().GROUPS_DATA_DIR;
    this.logger = options.logger.child({ component: "session-ttl-cleaner" });
    this.ttlMs = options.ttlMs ?? 30 * 24 * 60 * 60 * 1000;
    const redisUrl = options.redisUrl ?? getConfig().REDIS_URL;
    this.activityIndex = new SessionActivityIndex({
      redisUrl,
      logger: this.logger,
    });
  }

  async cleanup(): Promise<number> {
    const now = Date.now();
    let removed = 0;

    const expired = await this.activityIndex.fetchExpired(now - this.ttlMs);
    for (const key of expired) {
      const sessionPath = join(
        this.dataDir,
        key.groupId,
        "sessions",
        key.sessionId,
      );
      const metaPath = join(sessionPath, "meta.json");
      const meta = await this.readMeta(metaPath);
      if (meta?.status === "running") {
        continue;
      }
      if (!(await this.exists(sessionPath))) {
        await this.activityIndex.remove(key);
        continue;
      }
      await rm(sessionPath, { recursive: true, force: true });
      await this.activityIndex.remove(key);
      removed += 1;
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

  private async exists(targetPath: string): Promise<boolean> {
    try {
      await access(targetPath, constants.F_OK);
      return true;
    } catch {
      return false;
    }
  }
}
