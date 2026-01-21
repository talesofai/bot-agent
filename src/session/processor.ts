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
import { redactSensitiveText } from "../utils/redact";
import {
  type TelemetrySpanInput,
  resolveTraceId,
  setTraceIdOnExtras,
  withTelemetrySpan,
} from "../telemetry";

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
    const traceId = resolveTraceId(jobData.traceId);
    const jobId = String(job.id ?? `job-${Date.now()}`);
    const log = this.logger.child({
      traceId,
      jobId,
      botId: jobData.botId,
      groupId: jobData.groupId,
      sessionId: jobData.sessionId,
      userId: jobData.userId,
      key: jobData.key,
    });
    const spanMessage = {
      botId: jobData.botId,
      groupId: jobData.groupId,
      userId: jobData.userId,
      key: jobData.key,
      sessionId: jobData.sessionId,
    };
    const span = async <T>(
      step: string,
      fn: () => Promise<T>,
      attrs?: Record<string, unknown>,
    ): Promise<T> =>
      withTelemetrySpan(
        log,
        {
          traceId,
          phase: "worker",
          step,
          component: "session-processor",
          message: spanMessage,
          job: { id: jobId },
          attrs,
        },
        fn,
      );

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

    const now = Date.now();
    const queueDelayMs =
      typeof jobData.enqueuedAt === "number" &&
      Number.isFinite(jobData.enqueuedAt)
        ? Math.max(0, now - jobData.enqueuedAt)
        : undefined;
    const e2eAgeMs =
      typeof jobData.traceStartedAt === "number" &&
      Number.isFinite(jobData.traceStartedAt)
        ? Math.max(0, now - jobData.traceStartedAt)
        : undefined;

    await span(
      "job_process",
      async () => {
        try {
          const bufferKey = toBufferKey(jobData);
          const gateToken = jobData.gateToken;
          const gateOk = await span("gate_claim_initial", async () =>
            this.bufferStore.claimGate(bufferKey, gateToken),
          );
          if (!gateOk) {
            log.debug(
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
                log.warn(
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
              log.debug(
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
              await withTelemetrySpan(
                log,
                {
                  traceId,
                  phase: "worker",
                  step: "process_batch",
                  component: "session-processor",
                  message: spanMessage,
                  job: { id: jobId },
                  attrs: { bufferedCount: buffered.length },
                },
                async () => {
                  if (!sessionInfo) {
                    sessionInfo = await span("ensure_session", async () =>
                      this.ensureSession(
                        jobData.botId,
                        jobData.groupId,
                        jobData.userId,
                        jobData.key,
                        jobData.sessionId,
                      ),
                    );
                    await span("record_activity", async () =>
                      this.recordActivity(sessionInfo!, log),
                    );

                    sessionInfo = await span(
                      "update_status_running",
                      async () => this.updateStatus(sessionInfo!, "running"),
                    );
                    statusUpdated = true;
                    await span("record_activity", async () =>
                      this.recordActivity(sessionInfo!, log),
                    );
                  }

                  const { mergedSession, promptInput } =
                    buildBufferedInput(buffered);
                  const mergedWithTrace: SessionEvent = {
                    ...mergedSession,
                    extras: setTraceIdOnExtras(mergedSession.extras, traceId),
                  };
                  const batchMessage = {
                    ...spanMessage,
                    platform: mergedWithTrace.platform,
                    channelId: mergedWithTrace.channelId,
                    messageId: mergedWithTrace.messageId,
                  };
                  const batchSpan = async <T>(
                    step: string,
                    fn: () => Promise<T>,
                    attrs?: Record<string, unknown>,
                  ): Promise<T> =>
                    withTelemetrySpan(
                      log,
                      {
                        traceId,
                        phase: "worker",
                        step,
                        component: "session-processor",
                        message: batchMessage,
                        job: { id: jobId },
                        attrs,
                      },
                      fn,
                    );

                  const stopTyping = this.startTyping(mergedWithTrace, log);
                  try {
                    const historyKey = resolveHistoryKey(mergedWithTrace);
                    const { history, launchSpec } =
                      await this.buildPromptContext(
                        jobData.groupId,
                        sessionInfo!,
                        mergedWithTrace,
                        historyKey,
                        promptInput,
                        { traceId, jobId, logger: log, message: batchMessage },
                      );

                    const result = await batchSpan(
                      "opencode_run",
                      async () =>
                        this.runner.run({
                          job: this.mapJob(job),
                          session: sessionInfo!,
                          history,
                          launchSpec,
                        }),
                      { historyEntries: history.length },
                    );
                    const stillOwnerAfterRun = await this.bufferStore.claimGate(
                      bufferKey,
                      gateToken,
                    );
                    if (!stillOwnerAfterRun) {
                      log.warn(
                        { sessionId: jobData.sessionId, botId: jobData.botId },
                        "Discarding session result due to gate token mismatch after run",
                      );
                      try {
                        await this.bufferStore.requeueFront(
                          bufferKey,
                          buffered,
                        );
                      } catch (err) {
                        log.error(
                          {
                            err,
                            sessionId: jobData.sessionId,
                            botId: jobData.botId,
                          },
                          "Failed to requeue buffered messages after gate loss",
                        );
                      }
                      shouldSetIdle = false;
                      return;
                    }
                    const output = resolveOutput(result.output);
                    const auditedOutput = output
                      ? redactSensitiveText(output)
                      : undefined;

                    await batchSpan("send_response", async () =>
                      this.sendResponse(mergedWithTrace, auditedOutput),
                    );
                    await batchSpan("append_history", async () =>
                      this.appendHistoryFromJob(
                        sessionInfo!,
                        mergedWithTrace,
                        historyKey,
                        result.historyEntries,
                        result.streamEvents,
                        auditedOutput,
                        { stdout: result.rawStdout, stderr: result.rawStderr },
                      ),
                    );
                    await batchSpan("record_activity", async () =>
                      this.recordActivity(sessionInfo!, log),
                    );
                  } finally {
                    stopTyping();
                  }
                },
              );
            } catch (err) {
              log.error(
                { err, sessionId: jobData.sessionId, botId: jobData.botId },
                "Failed to process buffered session messages; requeuing",
              );
              try {
                await this.bufferStore.requeueFront(bufferKey, buffered);
              } catch (requeueErr) {
                log.error(
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
          log.error(
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
              log.warn({ err }, "Failed to update session status to idle");
            }
          }
        }
      },
      {
        traceStartedAt: jobData.traceStartedAt,
        enqueuedAt: jobData.enqueuedAt,
        queueDelayMs,
        e2eAgeMs,
      },
    );
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
    telemetry?: {
      traceId: string;
      jobId: string;
      logger: Logger;
      message: TelemetrySpanInput["message"];
    },
  ): Promise<{
    history: HistoryEntry[];
    launchSpec: OpencodeLaunchSpec;
  }> {
    const span = async <T>(
      step: string,
      fn: () => Promise<T>,
      attrs?: Record<string, unknown>,
    ): Promise<T> => {
      if (!telemetry) {
        return fn();
      }
      return withTelemetrySpan(
        telemetry.logger,
        {
          traceId: telemetry.traceId,
          phase: "worker",
          step,
          component: "session-processor",
          message: telemetry.message,
          job: { id: telemetry.jobId },
          attrs,
        },
        fn,
      );
    };

    const history = historyKey
      ? await span(
          "history_read",
          async () =>
            this.historyStore.readHistory(historyKey, {
              maxEntries: this.historyMaxEntries,
              maxBytes: this.historyMaxBytes,
            }),
          {
            maxEntries: this.historyMaxEntries,
            maxBytes: this.historyMaxBytes,
          },
        )
      : [];
    const visibleHistory = history.filter((entry) => {
      if (entry.includeInContext === false) {
        return false;
      }
      if (entry.groupId !== sessionInfo.meta.groupId) {
        return false;
      }
      if (entry.sessionId !== sessionInfo.meta.sessionId) {
        return false;
      }
      return true;
    });
    const groupConfig = await span("load_group_config", async () =>
      this.getGroupConfig(groupId),
    );
    const agentPrompt = await span("load_agent_prompt", async () =>
      this.getAgentPrompt(groupId),
    );
    const systemPrompt = buildSystemPrompt(agentPrompt);
    const resolvedInput = resolveSessionInput(promptInput);
    const prompt = buildOpencodePrompt({
      systemPrompt,
      history: visibleHistory,
      input: resolvedInput,
    });
    const promptBytes = Buffer.byteLength(prompt, "utf8");
    const launchSpec = await span(
      "build_launch_spec",
      async () =>
        this.launcher.buildLaunchSpec(sessionInfo, prompt, groupConfig.model, {
          traceId: telemetry?.traceId,
        }),
      {
        promptBytes,
        historyEntries: visibleHistory.length,
        modelOverride: groupConfig.model,
      },
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
      sessionId,
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
    runLogs?: { stdout?: string; stderr?: string },
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
      sessionId: sessionInfo.meta.sessionId,
    });

    if (streamEvents && streamEvents.length > 0) {
      for (const [index, event] of streamEvents.entries()) {
        if (!event.text) {
          continue;
        }
        const redactedText = redactSensitiveText(event.text);
        entries.push({
          role: "system",
          content: redactedText,
          createdAt: nowIso,
          groupId: sessionInfo.meta.groupId,
          sessionId: sessionInfo.meta.sessionId,
          includeInContext: false,
          trace: {
            source: "opencode",
            type: event.type,
            index,
          },
        });
      }
    }

    const logMaxBytes = 20_000;
    const stdout = runLogs?.stdout?.trim();
    if (stdout) {
      const trimmed = truncateTextByBytes(
        redactSensitiveText(stdout),
        logMaxBytes,
      );
      entries.push({
        role: "system",
        content: trimmed.content,
        createdAt: nowIso,
        groupId: sessionInfo.meta.groupId,
        sessionId: sessionInfo.meta.sessionId,
        includeInContext: false,
        trace: {
          source: "opencode",
          type: "raw_stdout",
          truncated: trimmed.truncated,
          maxBytes: logMaxBytes,
        },
      });
    }
    const stderr = runLogs?.stderr?.trim();
    if (stderr) {
      const trimmed = truncateTextByBytes(
        redactSensitiveText(stderr),
        logMaxBytes,
      );
      entries.push({
        role: "system",
        content: trimmed.content,
        createdAt: nowIso,
        groupId: sessionInfo.meta.groupId,
        sessionId: sessionInfo.meta.sessionId,
        includeInContext: false,
        trace: {
          source: "opencode",
          type: "raw_stderr",
          truncated: trimmed.truncated,
          maxBytes: logMaxBytes,
        },
      });
    }

    const nonUserEntries =
      historyEntries?.filter((entry) => entry.role !== "user") ?? [];
    if (nonUserEntries.length > 0) {
      entries.push(
        ...nonUserEntries.map((entry) => ({
          ...entry,
          groupId: sessionInfo.meta.groupId,
          sessionId: sessionInfo.meta.sessionId,
          includeInContext:
            entry.includeInContext ??
            (entry.role === "system" ? false : undefined),
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
        sessionId: sessionInfo.meta.sessionId,
      });
    }

    for (const entry of entries) {
      await this.historyStore.appendHistory(historyKey, entry);
    }
  }

  private async recordActivity(
    sessionInfo: SessionInfo,
    log: Logger,
  ): Promise<void> {
    try {
      await this.activityIndex.recordActivity({
        botId: sessionInfo.meta.botId,
        groupId: sessionInfo.meta.groupId,
        sessionId: sessionInfo.meta.sessionId,
      });
    } catch (err) {
      log.warn({ err }, "Failed to record session activity");
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

  private startTyping(session: SessionEvent, log: Logger): () => void {
    if (session.platform !== "discord") {
      return () => {};
    }
    const sendTyping = this.adapter.sendTyping;
    if (!sendTyping) {
      return () => {};
    }
    const trigger = () => {
      void sendTyping.call(this.adapter, session).catch((err) => {
        log.debug(
          { err, sessionId: session.messageId, platform: session.platform },
          "Failed to send typing indicator",
        );
      });
    };
    trigger();
    const timer = setInterval(trigger, 7_000);
    return () => {
      clearInterval(timer);
    };
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

function truncateTextByBytes(
  content: string,
  maxBytes: number,
): { content: string; truncated: boolean } {
  if (maxBytes <= 0) {
    return { content: "", truncated: content.length > 0 };
  }
  const buffer = Buffer.from(content, "utf-8");
  if (buffer.byteLength <= maxBytes) {
    return { content, truncated: false };
  }
  const truncated = buffer.toString("utf-8", 0, maxBytes);
  return { content: `${truncated}\n\n[truncated]`, truncated: true };
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
