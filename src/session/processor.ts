import type { Logger } from "pino";

import type { SessionJob, SessionJobData } from "../queue";
import type { PlatformAdapter, SessionEvent } from "../types/platform";
import type { HistoryEntry, SessionInfo } from "../types/session";
import { GroupFileRepository } from "../store/repository";
import { SessionRepository } from "./repository";
import type { HistoryKey, HistoryStore } from "./history";
import { createSession } from "./session-ops";
import { buildBufferedInput, buildOpencodePrompt } from "../opencode/prompt";
import { buildSystemPrompt } from "../opencode/default-system-prompt";
import type { OpencodeLaunchSpec } from "../opencode/launcher";
import { OpencodeLauncher } from "../opencode/launcher";
import type { OpencodeStreamEvent } from "../opencode/output";
import type { OpencodeRunner } from "../worker/runner";
import type { SessionActivityIndex } from "./activity-store";
import type { SessionBuffer, SessionBufferKey } from "./buffer";
import { buildBotAccountId } from "../utils/bot-id";
import { extractOutputElements } from "./output-elements";

export interface SessionJobContext {
  id?: string | number | null;
  data: SessionJobData;
}

export interface SessionProcessorOptions {
  logger: Logger;
  adapter: PlatformAdapter;
  groupRepository: GroupFileRepository;
  sessionRepository: SessionRepository;
  historyStore: HistoryStore;
  launcher: OpencodeLauncher;
  runner: OpencodeRunner;
  activityIndex: SessionActivityIndex;
  bufferStore: SessionBuffer;
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
  private activityIndex: SessionActivityIndex;
  private bufferStore: SessionBuffer;
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
    job: SessionJobContext,
    jobData: SessionJobData,
  ): Promise<void> {
    let statusUpdated = false;
    let sessionInfo: SessionInfo | null = null;
    let shouldSetIdle = true;
    let gateHeartbeat: ReturnType<typeof setInterval> | null = null;
    let gateRefreshInFlight = false;

    const stopGateHeartbeat = () => {
      if (gateHeartbeat) {
        clearInterval(gateHeartbeat);
        gateHeartbeat = null;
      }
    };

    try {
      const bufferKey = toBufferKey(jobData);
      const gateToken = jobData.gateToken;
      const gateOk = await this.bufferStore.claimGate(bufferKey, gateToken);
      if (!gateOk) {
        this.logger.debug(
          { sessionId: jobData.sessionId, botId: jobData.botId },
          "Skipping session job due to gate token mismatch",
        );
        return;
      }

      const gateHeartbeatMs = Math.max(
        1000,
        Math.min(
          30_000,
          Math.floor((this.bufferStore.getGateTtlSeconds() * 1000) / 2),
        ),
      );
      gateHeartbeat = setInterval(() => {
        if (gateRefreshInFlight) {
          return;
        }
        gateRefreshInFlight = true;
        void this.bufferStore
          .refreshGate(bufferKey, gateToken)
          .then((ok) => {
            if (!ok) {
              stopGateHeartbeat();
            }
          })
          .catch((err) => {
            this.logger.warn(
              { err, sessionId: jobData.sessionId },
              "Failed to refresh session gate",
            );
          })
          .finally(() => {
            gateRefreshInFlight = false;
          });
      }, gateHeartbeatMs);

      let keepRunning = true;
      while (keepRunning) {
        const stillOwner = await this.bufferStore.claimGate(
          bufferKey,
          gateToken,
        );
        if (!stillOwner) {
          this.logger.debug(
            { sessionId: jobData.sessionId, botId: jobData.botId },
            "Stopping session job due to gate token mismatch",
          );
          shouldSetIdle = false;
          return;
        }
        const buffered = await this.bufferStore.drain(bufferKey);
        if (buffered.length === 0) {
          const shouldStop = await this.bufferStore.tryReleaseGate(
            bufferKey,
            gateToken,
          );
          if (shouldStop) {
            keepRunning = false;
            continue;
          }
          continue;
        }

        try {
          if (!sessionInfo) {
            sessionInfo = await this.ensureSession(
              jobData.botId,
              jobData.groupId,
              jobData.userId,
              jobData.key,
              jobData.sessionId,
            );
            await this.recordActivity(sessionInfo);

            sessionInfo = await this.updateStatus(sessionInfo, "running");
            statusUpdated = true;
            await this.recordActivity(sessionInfo);
          }

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
          const stillOwnerAfterRun = await this.bufferStore.claimGate(
            bufferKey,
            gateToken,
          );
          if (!stillOwnerAfterRun) {
            this.logger.warn(
              { sessionId: jobData.sessionId, botId: jobData.botId },
              "Discarding session result due to gate token mismatch after run",
            );
            try {
              await this.bufferStore.requeueFront(bufferKey, buffered);
            } catch (err) {
              this.logger.error(
                { err, sessionId: jobData.sessionId, botId: jobData.botId },
                "Failed to requeue buffered messages after gate loss",
              );
            }
            shouldSetIdle = false;
            return;
          }
          const output = resolveOutput(result.output);

          await this.sendResponse(mergedSession, output);
          await this.appendHistoryFromJob(
            sessionInfo,
            mergedSession,
            historyKey,
            result.historyEntries,
            result.streamEvents,
            output,
          );
          await this.recordActivity(sessionInfo);
        } catch (err) {
          this.logger.error(
            { err, sessionId: jobData.sessionId, botId: jobData.botId },
            "Failed to process buffered session messages; requeuing",
          );
          try {
            await this.bufferStore.requeueFront(bufferKey, buffered);
          } catch (requeueErr) {
            this.logger.error(
              {
                err: requeueErr,
                sessionId: jobData.sessionId,
                botId: jobData.botId,
              },
              "Failed to requeue buffered messages after error",
            );
          }
          throw err;
        }
      }
    } catch (err) {
      this.logger.error(
        { err, sessionId: jobData.sessionId },
        "Error processing session job",
      );
      throw err;
    } finally {
      stopGateHeartbeat();
      if (statusUpdated && sessionInfo && shouldSetIdle) {
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
    launchSpec: OpencodeLaunchSpec;
  }> {
    const history = historyKey
      ? await this.historyStore.readHistory(historyKey, {
          maxEntries: this.historyMaxEntries,
          maxBytes: this.historyMaxBytes,
        })
      : [];
    const visibleHistory = history.filter(
      (entry) => entry.includeInContext !== false,
    );
    const groupConfig = await this.getGroupConfig(groupId);
    const agentPrompt = await this.getAgentPrompt(groupId);
    const systemPrompt = buildSystemPrompt(agentPrompt);
    const resolvedInput = resolveSessionInput(promptInput);
    const prompt = buildOpencodePrompt({
      systemPrompt,
      history: visibleHistory,
      input: resolvedInput,
    });
    const launchSpec = await this.launcher.buildLaunchSpec(
      sessionInfo,
      prompt,
      groupConfig.model,
    );
    return { history: visibleHistory, launchSpec };
  }

  private async ensureSession(
    botId: string,
    groupId: string,
    userId: string,
    key: number,
    sessionId: string,
  ): Promise<SessionInfo> {
    const existing = await this.sessionRepository.loadSession(
      botId,
      groupId,
      userId,
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
      botId,
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
    streamEvents?: OpencodeStreamEvent[],
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

    if (streamEvents && streamEvents.length > 0) {
      for (const [index, event] of streamEvents.entries()) {
        if (!event.text) {
          continue;
        }
        entries.push({
          role: "system",
          content: event.text,
          createdAt: nowIso,
          groupId: sessionInfo.meta.groupId,
          includeInContext: false,
          trace: {
            source: "opencode",
            type: event.type,
            index,
          },
        });
      }
    }

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
        botId: sessionInfo.meta.botId,
        groupId: sessionInfo.meta.groupId,
        sessionId: sessionInfo.meta.sessionId,
      });
    } catch (err) {
      this.logger.warn({ err }, "Failed to record session activity");
    }
  }

  private mapJob(job: SessionJobContext): SessionJob {
    const id = String(job.id ?? `job-${Date.now()}`);
    return { id, data: job.data };
  }

  private async sendResponse(
    session: SessionEvent,
    output?: string,
  ): Promise<void> {
    if (!output) {
      return;
    }
    const { content, elements } = extractOutputElements(output);
    if (!content && elements.length === 0) {
      return;
    }
    await this.adapter.sendMessage(
      session,
      content,
      elements.length > 0 ? { elements } : undefined,
    );
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
    botAccountId: buildBotAccountId(session.platform, session.selfId),
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
