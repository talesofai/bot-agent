import { constants } from "node:fs";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Logger } from "pino";

import type { SessionInfo, SessionMeta } from "../types/session";
import { buildSessionId } from "./utils";
import { assertSafePathSegment } from "../utils/path";

export interface SessionRepositoryOptions {
  dataDir: string;
  logger: Logger;
}

interface SessionPaths {
  groupPath: string;
  sessionsPath: string;
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
    groupId: string,
    sessionId: string,
  ): Promise<SessionInfo | null> {
    const paths = this.buildSessionPaths(groupId, sessionId);
    const meta = await this.readMeta(paths.metaPath);
    if (!meta) {
      return null;
    }
    if (!this.isMetaConsistent(meta, groupId, sessionId)) {
      return null;
    }
    return this.buildSessionInfo(meta, paths);
  }

  async createSession(meta: SessionMeta): Promise<SessionInfo> {
    const paths = this.buildSessionPaths(meta.groupId, meta.sessionId);
    await this.ensureSessionDir(paths);
    await this.writeMeta(paths.metaPath, meta);
    return this.buildSessionInfo(meta, paths);
  }

  async updateMeta(meta: SessionMeta): Promise<SessionInfo> {
    const paths = this.buildSessionPaths(meta.groupId, meta.sessionId);
    await this.writeMeta(paths.metaPath, meta);
    return this.buildSessionInfo(meta, paths);
  }

  private buildSessionInfo(
    meta: SessionMeta,
    paths: SessionPaths,
  ): SessionInfo {
    return {
      meta,
      groupPath: paths.groupPath,
      workspacePath: paths.workspacePath,
      historyPath: paths.historyPath,
    };
  }

  private buildSessionPaths(groupId: string, sessionId: string): SessionPaths {
    assertSafePathSegment(sessionId, "sessionId");
    const groupPath = this.getGroupPath(groupId);
    const sessionsPath = join(groupPath, "sessions");
    const sessionPath = join(sessionsPath, sessionId);
    return {
      groupPath,
      sessionsPath,
      sessionPath,
      metaPath: join(sessionPath, "meta.json"),
      historyPath: join(sessionPath, "history.sqlite"),
      workspacePath: join(sessionPath, "workspace"),
    };
  }

  private async ensureSessionDir(paths: SessionPaths): Promise<void> {
    await mkdir(paths.sessionsPath, { recursive: true });
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
    groupId: string,
    sessionId: string,
  ): boolean {
    if (meta.groupId === groupId && meta.sessionId === sessionId) {
      return true;
    }
    this.logger.warn(
      {
        metaGroupId: meta.groupId,
        metaSessionId: meta.sessionId,
        groupId,
        sessionId,
      },
      "Session meta does not match expected identifiers",
    );
    return false;
  }
}

function isSessionMeta(value: unknown): value is SessionMeta {
  if (!value || typeof value !== "object") {
    return false;
  }
  const obj = value as Record<string, unknown>;
  return (
    typeof obj.sessionId === "string" &&
    typeof obj.groupId === "string" &&
    typeof obj.ownerId === "string" &&
    typeof obj.key === "number" &&
    Number.isInteger(obj.key) &&
    (obj.status === "idle" || obj.status === "running") &&
    typeof obj.createdAt === "string" &&
    typeof obj.updatedAt === "string"
  );
}
