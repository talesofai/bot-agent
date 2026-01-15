import { constants } from "node:fs";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Logger } from "pino";
import { z } from "zod";

import type { SessionInfo, SessionMeta } from "../types/session";
import { buildSessionId } from "./utils";
import { assertSafePathSegment } from "../utils/path";

export interface SessionRepositoryOptions {
  dataDir: string;
  logger: Logger;
}

interface SessionPaths {
  sessionPath: string;
  metaPath: string;
  historyPath: string;
  workspacePath: string;
}

export class SessionRepository {
  private dataDir: string;
  private logger: Logger;

  constructor(options: SessionRepositoryOptions) {
    this.dataDir = options.dataDir;
    this.logger = options.logger.child({ component: "session-repository" });
  }

  getGroupPath(groupId: string): string {
    assertSafePathSegment(groupId, "groupId");
    return join(this.dataDir, groupId);
  }

  getSessionId(userId: string, key: number): string {
    return buildSessionId(userId, key);
  }

  async loadSession(
    botId: string,
    userId: string,
    sessionId: string,
  ): Promise<SessionInfo | null> {
    const paths = this.buildSessionPaths(botId, userId, sessionId);
    const meta = await this.readMeta(paths.metaPath);
    if (!meta) {
      return null;
    }
    if (!this.isMetaConsistent(meta, botId, userId, sessionId)) {
      return null;
    }
    return this.buildSessionInfo(meta, paths);
  }

  async createSession(meta: SessionMeta): Promise<SessionInfo> {
    const paths = this.buildSessionPaths(
      meta.botId,
      meta.ownerId,
      meta.sessionId,
    );
    await this.ensureSessionDir(paths);
    await this.writeMeta(paths.metaPath, meta);
    return this.buildSessionInfo(meta, paths);
  }

  async updateMeta(meta: SessionMeta): Promise<SessionInfo> {
    const paths = this.buildSessionPaths(
      meta.botId,
      meta.ownerId,
      meta.sessionId,
    );
    await this.writeMeta(paths.metaPath, meta);
    return this.buildSessionInfo(meta, paths);
  }

  private buildSessionInfo(
    meta: SessionMeta,
    paths: SessionPaths,
  ): SessionInfo {
    return {
      meta,
      groupPath: this.getGroupPath(meta.groupId),
      workspacePath: paths.workspacePath,
      historyPath: paths.historyPath,
    };
  }

  private buildSessionPaths(
    botId: string,
    userId: string,
    sessionId: string,
  ): SessionPaths {
    assertSafePathSegment(botId, "botId");
    assertSafePathSegment(userId, "userId");
    assertSafePathSegment(sessionId, "sessionId");
    const sessionsRoot = join(this.dataDir, "sessions", botId, userId);
    const sessionPath = join(sessionsRoot, sessionId);
    return {
      sessionPath,
      metaPath: join(sessionPath, "meta.json"),
      historyPath: join(sessionPath, "history.sqlite"),
      workspacePath: join(sessionPath, "workspace"),
    };
  }

  private async ensureSessionDir(paths: SessionPaths): Promise<void> {
    await mkdir(join(this.dataDir, "sessions"), { recursive: true });
    await mkdir(paths.sessionPath, { recursive: true });
    await mkdir(paths.workspacePath, { recursive: true });
    await mkdir(join(paths.workspacePath, "input"), { recursive: true });
    await mkdir(join(paths.workspacePath, "output"), { recursive: true });
  }

  private async readMeta(metaPath: string): Promise<SessionMeta | null> {
    if (!(await this.exists(metaPath))) {
      return null;
    }
    try {
      const raw = await readFile(metaPath, "utf-8");
      const parsed = JSON.parse(raw) as unknown;
      if (!isSessionMeta(parsed)) {
        this.logger.warn({ metaPath }, "Invalid session meta shape");
        return null;
      }
      return parsed;
    } catch (err) {
      this.logger.warn({ err, metaPath }, "Failed to read session meta");
      return null;
    }
  }

  private async writeMeta(metaPath: string, meta: SessionMeta): Promise<void> {
    const payload = JSON.stringify(meta, null, 2);
    await writeFile(metaPath, payload, "utf-8");
  }

  private async exists(targetPath: string): Promise<boolean> {
    try {
      await access(targetPath, constants.F_OK);
      return true;
    } catch {
      return false;
    }
  }

  private isMetaConsistent(
    meta: SessionMeta,
    botId: string,
    ownerId: string,
    sessionId: string,
  ): boolean {
    if (
      meta.botId === botId &&
      meta.ownerId === ownerId &&
      meta.sessionId === sessionId
    ) {
      return true;
    }
    this.logger.warn(
      {
        metaBotId: meta.botId,
        metaOwnerId: meta.ownerId,
        metaGroupId: meta.groupId,
        metaSessionId: meta.sessionId,
        botId,
        ownerId,
        sessionId,
      },
      "Session meta does not match expected identifiers",
    );
    return false;
  }
}

const sessionMetaSchema = z
  .object({
    sessionId: z.string(),
    groupId: z.string(),
    ownerId: z.string(),
    botId: z.string(),
    key: z.number().int(),
    status: z.enum(["idle", "running"]),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .passthrough();

function isSessionMeta(value: unknown): value is SessionMeta {
  return sessionMetaSchema.safeParse(value).success;
}
