import type { Logger } from "pino";

import { config as appConfig } from "../config";
import { logger as defaultLogger } from "../logger";
import { GroupFileRepository } from "../store/repository";
import type { GroupConfig } from "../types/group";
import type {
  HistoryEntry,
  SessionInfo,
  SessionMeta,
  SessionStatus,
} from "../types/session";
import { HistoryStore, type HistoryReadOptions } from "./history";
import { SessionRepository } from "./repository";

export interface SessionManagerOptions {
  dataDir?: string;
  logger?: Logger;
  configCacheTtlMs?: number;
}

export interface CreateSessionOptions {
  key?: number;
  allowMultipleSessions?: boolean;
}

export class SessionManager {
  private logger: Logger;
  private dataDir: string;
  private groupRepository: GroupFileRepository;
  private sessionRepository: SessionRepository;
  private historyStore: HistoryStore;
  private ensuredGroups = new Set<string>();
  private configCache = new Map<string, { config: GroupConfig; loadedAt: number }>();
  private configCacheTtlMs: number;

  constructor(options: SessionManagerOptions = {}) {
    this.dataDir = options.dataDir ?? appConfig.GROUPS_DATA_DIR;
    this.logger = (options.logger ?? defaultLogger).child({
      component: "session-manager",
    });
    this.groupRepository = new GroupFileRepository({
      dataDir: this.dataDir,
      logger: this.logger,
    });
    this.sessionRepository = new SessionRepository({
      dataDir: this.dataDir,
      logger: this.logger,
    });
    this.historyStore = new HistoryStore(this.logger);
    this.configCacheTtlMs = options.configCacheTtlMs ?? 30_000;
  }

  async createSession(
    groupId: string,
    userId: string,
    options: CreateSessionOptions = {},
  ): Promise<SessionInfo> {
    const key = options.key ?? 0;
    this.assertValidKey(key);

    await this.ensureGroupDir(groupId);
    const config = await this.getGroupConfig(groupId);

    const allowMultipleSessions =
      options.allowMultipleSessions ?? config.allowMultipleSessions;

    if (key !== 0 && !allowMultipleSessions) {
      throw new Error("Multiple sessions are not allowed for this group");
    }

    const sessionId = this.sessionRepository.getSessionId(userId, key);
    const paths = this.sessionRepository.getSessionPaths(groupId, sessionId);
    await this.sessionRepository.ensureSessionDir(paths);

    const existing = await this.sessionRepository.readMeta(paths.metaPath);
    if (existing) {
      if (existing.ownerId !== userId) {
        throw new Error("Session ownership mismatch");
      }
      return { meta: existing, paths };
    }

    const now = new Date().toISOString();
    const meta: SessionMeta = {
      sessionId,
      groupId,
      ownerId: userId,
      key,
      status: "idle",
      createdAt: now,
      updatedAt: now,
    };

    await this.sessionRepository.writeMeta(paths.metaPath, meta);
    return { meta, paths };
  }

  async getSession(groupId: string, sessionId: string): Promise<SessionInfo | null> {
    const paths = this.sessionRepository.getSessionPaths(groupId, sessionId);
    const meta = await this.sessionRepository.readMeta(paths.metaPath);
    if (!meta) {
      return null;
    }
    return { meta, paths };
  }

  async updateStatus(
    sessionInfo: SessionInfo,
    status: SessionStatus,
  ): Promise<SessionInfo> {
    const updated: SessionMeta = {
      ...sessionInfo.meta,
      status,
      updatedAt: new Date().toISOString(),
    };
    await this.sessionRepository.writeMeta(sessionInfo.paths.metaPath, updated);
    return { ...sessionInfo, meta: updated };
  }

  async readHistory(
    sessionInfo: SessionInfo,
    options?: HistoryReadOptions,
  ): Promise<HistoryEntry[]> {
    return this.historyStore.readHistory(sessionInfo.paths.historyPath, options);
  }

  async appendHistory(
    sessionInfo: SessionInfo,
    entry: HistoryEntry,
  ): Promise<void> {
    await this.historyStore.appendHistory(sessionInfo.paths.historyPath, entry);
  }

  private assertValidKey(key: number): void {
    if (!Number.isInteger(key) || key < 0) {
      throw new Error("Session key must be a non-negative integer");
    }
  }

  private async ensureGroupDir(groupId: string): Promise<void> {
    if (this.ensuredGroups.has(groupId)) {
      return;
    }
    await this.groupRepository.ensureGroupDir(groupId);
    this.ensuredGroups.add(groupId);
  }

  private async getGroupConfig(groupId: string): Promise<GroupConfig> {
    const cached = this.configCache.get(groupId);
    const now = Date.now();
    if (cached && now - cached.loadedAt < this.configCacheTtlMs) {
      return cached.config;
    }
    const groupPath = this.sessionRepository.getGroupPath(groupId);
    const config = await this.groupRepository.loadConfig(groupPath);
    this.configCache.set(groupId, { config, loadedAt: now });
    return config;
  }
}
