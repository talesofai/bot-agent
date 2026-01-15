import type { Job } from "bullmq";
import type { Logger } from "pino";

import type { SessionJob, SessionJobData } from "../queue";
import type { PlatformAdapter, SessionEvent } from "../types/platform";
import type { HistoryEntry, SessionInfo } from "../types/session";
import { GroupFileRepository } from "../store/repository";
import { SessionRepository } from "./repository";
import type { HistoryKey, HistoryStore } from "./history";
import { createSession } from "./session-ops";
import { buildBufferedInput, buildOpencodePrompt } from "../opencode/prompt";
import { buildSystemPrompt } from "../opencode/system-prompt";
import { OpencodeLauncher } from "../opencode/launcher";
import type { OpencodeRunner } from "../worker/runner";
import { SessionActivityStore } from "./activity-store";
import { SessionBufferStore } from "./buffer";
import type { SessionBufferKey } from "./buffer";

export interface SessionProcessorOptions {
  logger: Logger;
  adapter: PlatformAdapter;
  groupRepository: GroupFileRepository;
  sessionRepository: SessionRepository;
  historyStore: HistoryStore;
  launcher: OpencodeLauncher;
  runner: OpencodeRunner;
  activityIndex: SessionActivityStore;
  bufferStore: SessionBufferStore;
  limits?: {
    historyEntries?: number;
    historyBytes?: number;
  };
}

export class SessionProcessor {
  private logger: Logger;
  private adapter: PlatformAdapter;
  private groupRepository: GroupFileRepository;
  private sessionRepository: SessionRepository;
  private historyStore: HistoryStore;
  private launcher: OpencodeLauncher;
  private runner: OpencodeRunner;
  private activityIndex: SessionActivityStore;
  private bufferStore: SessionBufferStore;
  private historyMaxEntries?: number;
  private historyMaxBytes?: number;

  constructor(options: SessionProcessorOptions) {
    this.logger = options.logger.child({ component: "session-processor" });
    this.adapter = options.adapter;
    this.groupRepository = options.groupRepository;
    this.sessionRepository = options.sessionRepository;
    this.historyStore = options.historyStore;
    this.launcher = options.launcher;
    this.runner = options.runner;
    this.activityIndex = options.activityIndex;
    this.bufferStore = options.bufferStore;
    this.historyMaxEntries = options.limits?.historyEntries;
    this.historyMaxBytes = options.limits?.historyBytes;
  }

  async process(
    job: Job<SessionJobData>,
    jobData: SessionJobData,
  ): Promise<void> {
    let statusUpdated = false;
    let sessionInfo: SessionInfo | null = null;

    try {
      const bufferKey = toBufferKey(jobData);
      let buffered = await this.bufferStore.drain(bufferKey);
      if (buffered.length === 0) {
        return;
      }

      sessionInfo = await this.ensureSession(
        jobData.groupId,
        jobData.userId,
        jobData.key,
        jobData.sessionId,
      );
      await this.recordActivity(sessionInfo);

      sessionInfo = await this.updateStatus(sessionInfo, "running");
      statusUpdated = true;
      await this.recordActivity(sessionInfo);

      while (buffered.length > 0) {
        const { mergedSession, promptInput } = buildBufferedInput(buffered);
        const historyKey = resolveHistoryKey(mergedSession);
        const { history, launchSpec } = await this.buildPromptContext(
          jobData.groupId,
          sessionInfo,
          mergedSession,
          historyKey,
          promptInput,
        );

        const result = await this.runner.run({
          job: this.mapJob(job),
          session: sessionInfo,
          history,
          launchSpec,
        });
        const output = resolveOutput(result.output);

        await this.appendHistoryFromJob(
          sessionInfo,
          mergedSession,
          historyKey,
          result.historyEntries,
          output,
        );
        await this.recordActivity(sessionInfo);
        await this.sendResponse(mergedSession, output);

        buffered = await this.drainPendingBuffer(bufferKey);
      }
    } catch (err) {
      this.logger.error(
        { err, sessionId: jobData.sessionId },
        "Error processing session job",
      );
      throw err;
    } finally {
      if (statusUpdated && sessionInfo) {
        try {
          await this.updateStatus(sessionInfo, "idle");
        } catch (err) {
          this.logger.warn({ err }, "Failed to update session status to idle");
        }
      }
    }
  }

  async close(): Promise<void> {
    await this.activityIndex.close();
    await this.bufferStore.close();
    await this.historyStore.close();
  }

  private async buildPromptContext(
    groupId: string,
    sessionInfo: SessionInfo,
    sessionInput: SessionEvent,
    historyKey: HistoryKey | null,
    promptInput: string,
  ): Promise<{
    history: HistoryEntry[];
    launchSpec: ReturnType<OpencodeLauncher["buildLaunchSpec"]>;
  }> {
    const history = historyKey
      ? await this.historyStore.readHistory(historyKey, {
          maxEntries: this.historyMaxEntries,
          maxBytes: this.historyMaxBytes,
        })
      : [];
    const groupConfig = await this.getGroupConfig(groupId);
    const agentPrompt = await this.getAgentPrompt(groupId);
    const systemPrompt = buildSystemPrompt(agentPrompt);
    const resolvedInput = resolveSessionInput(promptInput);
    const prompt = buildOpencodePrompt({
      systemPrompt,
      history,
      input: resolvedInput,
    });
    const launchSpec = this.launcher.buildLaunchSpec(
      sessionInfo,
      prompt,
      groupConfig.model,
    );
    return { history, launchSpec };
  }

  private async drainPendingBuffer(
    key: SessionBufferKey,
  ): Promise<SessionEvent[]> {
    let buffered = await this.bufferStore.drain(key);
    if (buffered.length === 0) {
      const pending = await this.bufferStore.consumePending(key);
      if (pending) {
        buffered = await this.bufferStore.drain(key);
      }
    }
    return buffered;
  }

  private async ensureSession(
    groupId: string,
    userId: string,
    key: number,
    sessionId: string,
  ): Promise<SessionInfo> {
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
    return createSession({
      groupId,
      userId,
      key,
      groupRepository: this.groupRepository,
      sessionRepository: this.sessionRepository,
    });
  }

  private async updateStatus(
    sessionInfo: SessionInfo,
    status: "idle" | "running",
  ): Promise<SessionInfo> {
    const updated: SessionInfo["meta"] = {
      ...sessionInfo.meta,
      status,
      updatedAt: new Date().toISOString(),
    };
    return this.sessionRepository.updateMeta(updated);
  }

  private async getGroupConfig(groupId: string) {
    await this.groupRepository.ensureGroupDir(groupId);
    const groupPath = this.sessionRepository.getGroupPath(groupId);
    return this.groupRepository.loadConfig(groupPath);
  }

  private async getAgentPrompt(groupId: string): Promise<string> {
    await this.groupRepository.ensureGroupDir(groupId);
    const groupPath = this.sessionRepository.getGroupPath(groupId);
    const agentContent = await this.groupRepository.loadAgentPrompt(groupPath);
    return agentContent.content;
  }

  private async appendHistoryFromJob(
    sessionInfo: SessionInfo,
    session: SessionEvent,
    historyKey: HistoryKey | null,
    historyEntries?: HistoryEntry[],
    output?: string,
  ): Promise<void> {
    if (!historyKey) {
      return;
    }
    const entries: HistoryEntry[] = [];

    const nowIso = new Date().toISOString();
    const userCreatedAt = resolveUserCreatedAt(session.timestamp, nowIso);
    // Persist a single space so downstream storage never sees an empty user input.
    const userContent = session.content.trim() ? session.content : " ";
    entries.push({
      role: "user",
      content: userContent,
      createdAt: userCreatedAt,
      groupId: sessionInfo.meta.groupId,
    });

    const nonUserEntries =
      historyEntries?.filter((entry) => entry.role !== "user") ?? [];
    if (nonUserEntries.length > 0) {
      entries.push(
        ...nonUserEntries.map((entry) => ({
          ...entry,
          groupId: sessionInfo.meta.groupId,
        })),
      );
    }

    const hasAssistantEntry = nonUserEntries.some(
      (entry) => entry.role === "assistant",
    );
    if (!hasAssistantEntry && output) {
      entries.push({
        role: "assistant",
        content: output,
        createdAt: nowIso,
        groupId: sessionInfo.meta.groupId,
      });
    }

    for (const entry of entries) {
      await this.historyStore.appendHistory(historyKey, entry);
    }
  }

  private async recordActivity(sessionInfo: SessionInfo): Promise<void> {
    try {
      await this.activityIndex.recordActivity({
        groupId: sessionInfo.meta.groupId,
        sessionId: sessionInfo.meta.sessionId,
      });
    } catch (err) {
      this.logger.warn({ err }, "Failed to record session activity");
    }
  }

  private mapJob(job: Job<SessionJobData>): SessionJob {
    const id = job.id ? String(job.id) : `job-${Date.now()}`;
    return { id, data: job.data };
  }

  private async sendResponse(
    session: SessionEvent,
    output?: string,
  ): Promise<void> {
    if (!output) {
      return;
    }
    try {
      await this.adapter.sendMessage(session, output);
    } catch (err) {
      this.logger.error(
        { err, sessionId: session.messageId },
        "Failed to send response",
      );
    }
  }
}

function resolveUserCreatedAt(
  timestamp: number | undefined,
  fallback: string,
): string {
  if (typeof timestamp !== "number" || !Number.isFinite(timestamp)) {
    return fallback;
  }
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) {
    return fallback;
  }
  return date.toISOString();
}

function resolveSessionInput(content: string): string {
  const trimmed = content.trim();
  if (trimmed) {
    return content;
  }
  // Opencode rejects empty input, but we still need a non-empty placeholder.
  return " ";
}

function resolveOutput(output?: string): string | undefined {
  if (!output) {
    return undefined;
  }
  return output.trim() ? output : undefined;
}

function resolveHistoryKey(session: SessionEvent): HistoryKey | null {
  if (!session.selfId) {
    return null;
  }
  return {
    botAccountId: `${session.platform}:${session.selfId}`,
    userId: session.userId,
  };
}

function toBufferKey(jobData: SessionJobData): SessionBufferKey {
  return {
    botId: jobData.botId,
    groupId: jobData.groupId,
    sessionId: jobData.sessionId,
  };
}
