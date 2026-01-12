import type { Logger } from "pino";

import { getConfig } from "../config";
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
import { SessionActivityIndex } from "./activity-index";

export interface SessionManagerOptions {
  dataDir?: string;
  logger?: Logger;
  redisUrl?: string;
}

export interface CreateSessionOptions {
  key?: number;
  maxSessions?: number;
}

export class SessionManager {
  private logger: Logger;
  private dataDir: string;
  private groupRepository: GroupFileRepository;
  private sessionRepository: SessionRepository;
  private historyStore: HistoryStore;
  private activityIndex: SessionActivityIndex;

  constructor(options: SessionManagerOptions = {}) {
    this.dataDir = options.dataDir ?? getConfig().GROUPS_DATA_DIR;
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
    const redisUrl = options.redisUrl ?? getConfig().REDIS_URL;
    this.activityIndex = new SessionActivityIndex({
      redisUrl,
      logger: this.logger,
    });
  }

  async createSession(
    groupId: string,
    userId: string,
    options: CreateSessionOptions = {},
  ): Promise<SessionInfo> {
    const key = options.key ?? 0;

    await this.ensureGroupDir(groupId);
    const config = await this.getGroupConfig(groupId);

    const maxSessions = options.maxSessions ?? config.maxSessions;
    this.assertValidMaxSessions(maxSessions);

    if (key >= maxSessions) {
      throw new Error("Session key exceeds maxSessions for this group");
    }

    const sessionId = this.sessionRepository.getSessionId(userId, key);
    const existing = await this.sessionRepository.loadSession(
      groupId,
      sessionId,
    );
    if (existing) {
      if (existing.meta.ownerId !== userId) {
        throw new Error("Session ownership mismatch");
      }
      return existing;
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

    const session = await this.sessionRepository.createSession(meta);
    await this.activityIndex.recordActivity({
      groupId: meta.groupId,
      sessionId: meta.sessionId,
    });
    return session;
  }

  async getSession(
    groupId: string,
    sessionId: string,
  ): Promise<SessionInfo | null> {
    return this.sessionRepository.loadSession(groupId, sessionId);
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
    const session = await this.sessionRepository.updateMeta(updated);
    await this.activityIndex.recordActivity({
      groupId: updated.groupId,
      sessionId: updated.sessionId,
    });
    return session;
  }

  async readHistory(
    sessionInfo: SessionInfo,
    options?: HistoryReadOptions,
  ): Promise<HistoryEntry[]> {
    return this.historyStore.readHistory(sessionInfo.historyPath, options);
  }

  async getAgentPrompt(groupId: string): Promise<string> {
    const groupPath = this.sessionRepository.getGroupPath(groupId);
    const agentContent = await this.groupRepository.loadAgentPrompt(groupPath);
    return agentContent.content;
  }

  async appendHistory(
    sessionInfo: SessionInfo,
    entry: HistoryEntry,
  ): Promise<void> {
    await this.historyStore.appendHistory(sessionInfo.historyPath, entry);
    await this.activityIndex.recordActivity({
      groupId: sessionInfo.meta.groupId,
      sessionId: sessionInfo.meta.sessionId,
    });
  }

  private async ensureGroupDir(groupId: string): Promise<void> {
    await this.groupRepository.ensureGroupDir(groupId);
  }

  private async getGroupConfig(groupId: string): Promise<GroupConfig> {
    const groupPath = this.sessionRepository.getGroupPath(groupId);
    return this.groupRepository.loadConfig(groupPath);
  }

  private assertValidMaxSessions(maxSessions: number): void {
    if (!Number.isInteger(maxSessions) || maxSessions < 1) {
      throw new Error("maxSessions must be a positive integer");
    }
  }
}
