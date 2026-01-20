import { constants } from "node:fs";
import {
  access,
  mkdir,
  readFile,
  readdir,
  rename,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { Logger } from "pino";
import { z } from "zod";

import type { SessionInfo, SessionMeta } from "../types/session";
import { assertValidSessionKey, generateSessionId } from "./utils";
import { assertSafePathSegment, isSafePathSegment } from "../utils/path";

export interface SessionRepositoryOptions {
  dataDir: string;
  logger: Logger;
}

interface SessionPaths {
  sessionPath: string;
  metaPath: string;
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

  async listUserIds(botId: string, groupId: string): Promise<string[]> {
    assertSafePathSegment(botId, "botId");
    assertSafePathSegment(groupId, "groupId");

    const groupSessionsPath = join(this.dataDir, "sessions", botId, groupId);
    let entries;
    try {
      entries = await readdir(groupSessionsPath, { withFileTypes: true });
    } catch {
      return [];
    }

    return entries
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
      .map((entry) => entry.name)
      .filter((userId) => isSafePathSegment(userId));
  }

  async resolveActiveSessionId(
    botId: string,
    groupId: string,
    userId: string,
    key: number,
  ): Promise<string> {
    assertSafePathSegment(botId, "botId");
    assertSafePathSegment(groupId, "groupId");
    assertSafePathSegment(userId, "userId");
    assertValidSessionKey(key);

    const paths = this.buildUserPaths(botId, groupId, userId);
    await mkdir(paths.userPath, { recursive: true });

    const index = await this.readSessionIndex(paths.indexPath);
    const keyStr = String(key);
    const existing = index.active[keyStr];
    if (existing && isSafePathSegment(existing)) {
      const existingPaths = this.buildSessionPaths(
        botId,
        groupId,
        userId,
        existing,
      );
      const meta = await this.readMeta(existingPaths.metaPath);
      if (!meta || meta.active !== false) {
        return existing;
      }
    }

    const sessionId = generateSessionId();
    index.active[keyStr] = sessionId;
    index.updatedAt = new Date().toISOString();
    await this.writeSessionIndex(paths.indexPath, index);
    return sessionId;
  }

  async resetActiveSessionId(
    botId: string,
    groupId: string,
    userId: string,
    key: number,
  ): Promise<{ previousSessionId: string | null; sessionId: string }> {
    assertSafePathSegment(botId, "botId");
    assertSafePathSegment(groupId, "groupId");
    assertSafePathSegment(userId, "userId");
    assertValidSessionKey(key);

    const paths = this.buildUserPaths(botId, groupId, userId);
    await mkdir(paths.userPath, { recursive: true });

    const index = await this.readSessionIndex(paths.indexPath);
    const keyStr = String(key);
    const previousSessionId = index.active[keyStr];

    const sessionId = generateSessionId();
    index.active[keyStr] = sessionId;
    index.updatedAt = new Date().toISOString();
    await this.writeSessionIndex(paths.indexPath, index);

    return {
      previousSessionId:
        typeof previousSessionId === "string" &&
        isSafePathSegment(previousSessionId)
          ? previousSessionId
          : null,
      sessionId,
    };
  }

  async loadSession(
    botId: string,
    groupId: string,
    userId: string,
    sessionId: string,
  ): Promise<SessionInfo | null> {
    const paths = this.buildSessionPaths(botId, groupId, userId, sessionId);
    const meta = await this.readMeta(paths.metaPath);
    if (!meta) {
      return null;
    }
    if (!this.isMetaConsistent(meta, botId, groupId, userId, sessionId)) {
      return null;
    }
    return this.buildSessionInfo(meta, paths);
  }

  async createSession(meta: SessionMeta): Promise<SessionInfo> {
    const paths = this.buildSessionPaths(
      meta.botId,
      meta.groupId,
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
      meta.groupId,
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
    };
  }

  private buildSessionPaths(
    botId: string,
    groupId: string,
    userId: string,
    sessionId: string,
  ): SessionPaths {
    assertSafePathSegment(botId, "botId");
    assertSafePathSegment(groupId, "groupId");
    assertSafePathSegment(userId, "userId");
    assertSafePathSegment(sessionId, "sessionId");
    const sessionsRoot = join(this.dataDir, "sessions", botId, groupId, userId);
    const sessionPath = join(sessionsRoot, sessionId);
    return {
      sessionPath,
      metaPath: join(sessionPath, "meta.json"),
      workspacePath: join(sessionPath, "workspace"),
    };
  }

  private buildUserPaths(
    botId: string,
    groupId: string,
    userId: string,
  ): { userPath: string; indexPath: string } {
    assertSafePathSegment(botId, "botId");
    assertSafePathSegment(groupId, "groupId");
    assertSafePathSegment(userId, "userId");
    const userPath = join(this.dataDir, "sessions", botId, groupId, userId);
    return { userPath, indexPath: join(userPath, "index.json") };
  }

  private async readSessionIndex(indexPath: string): Promise<SessionIndexFile> {
    const parsed = await readJsonFile(indexPath, sessionIndexSchema);
    if (!parsed) {
      return { version: 1, active: {} };
    }
    return {
      version: 1,
      active: parsed.active ?? {},
      updatedAt: parsed.updatedAt,
    };
  }

  private async writeSessionIndex(
    indexPath: string,
    index: SessionIndexFile,
  ): Promise<void> {
    const dir = dirname(indexPath);
    const tmpPath = join(
      dir,
      `.${basename(indexPath)}.${process.pid}.${Date.now()}.tmp`,
    );
    const content = `${JSON.stringify(index, null, 2)}\n`;
    await writeFile(tmpPath, content, "utf-8");
    await rename(tmpPath, indexPath);
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
    groupId: string,
    ownerId: string,
    sessionId: string,
  ): boolean {
    if (
      meta.botId === botId &&
      meta.groupId === groupId &&
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
        groupId,
        ownerId,
        sessionId,
      },
      "Session meta does not match expected identifiers",
    );
    return false;
  }
}

type SessionIndexFile = {
  version: 1;
  active: Record<string, string>;
  updatedAt?: string;
};

const sessionIndexSchema = z
  .object({
    version: z.literal(1).default(1),
    active: z.record(z.string(), z.string()).default({}),
    updatedAt: z.string().optional(),
  })
  .passthrough();

const sessionMetaSchema = z
  .object({
    sessionId: z.string(),
    groupId: z.string(),
    ownerId: z.string(),
    botId: z.string(),
    key: z.number().int(),
    status: z.enum(["idle", "running"]),
    active: z.boolean().optional(),
    archivedAt: z.string().optional(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .passthrough();

function isSessionMeta(value: unknown): value is SessionMeta {
  return sessionMetaSchema.safeParse(value).success;
}

async function readJsonFile<T>(
  path: string,
  schema: z.ZodType<T>,
): Promise<T | null> {
  try {
    const raw = await readFile(path, "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    const validated = schema.safeParse(parsed);
    return validated.success ? validated.data : null;
  } catch {
    return null;
  }
}
