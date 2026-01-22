import type { Logger } from "pino";

import type { SessionJob, SessionJobData } from "../queue";
import type { PlatformAdapter, SessionEvent } from "../types/platform";
import type { HistoryEntry, SessionInfo } from "../types/session";
import { GroupFileRepository } from "../store/repository";
import { SessionRepository } from "./repository";
import type { HistoryKey, HistoryStore } from "./history";
import { createSession } from "./session-ops";
import {
  buildBufferedInput,
  buildOpencodeSystemContext,
} from "../opencode/prompt";
import { buildSystemPrompt } from "../opencode/default-system-prompt";
import type { OpencodeStreamEvent } from "../opencode/output";
import type { OpencodeRequestSpec, OpencodeRunner } from "../worker/runner";
import type { SessionActivityIndex } from "./activity-store";
import type { SessionBuffer, SessionBufferKey } from "./buffer";
import { buildBotAccountId } from "../utils/bot-id";
import { extractOutputElements } from "./output-elements";
import { redactSensitiveText } from "../utils/redact";
import type { OpencodeClient } from "../opencode/server-client";
import { appendInputAuditIfSuspicious } from "../opencode/input-audit";
import { ensureOpencodeSkills } from "../opencode/skills";
import { getConfig } from "../config";
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
  opencodeClient: OpencodeClient;
  runner: OpencodeRunner;
  activityIndex: SessionActivityIndex;
  bufferStore: SessionBuffer;
}

export class SessionProcessor {
  private logger: Logger;
  private adapter: PlatformAdapter;
  private groupRepository: GroupFileRepository;
  private sessionRepository: SessionRepository;
  private historyStore: HistoryStore;
  private opencodeClient: OpencodeClient;
  private runner: OpencodeRunner;
  private activityIndex: SessionActivityIndex;
  private bufferStore: SessionBuffer;

  constructor(options: SessionProcessorOptions) {
    this.logger = options.logger.child({ component: "session-processor" });
    this.adapter = options.adapter;
    this.groupRepository = options.groupRepository;
    this.sessionRepository = options.sessionRepository;
    this.historyStore = options.historyStore;
    this.opencodeClient = options.opencodeClient;
    this.runner = options.runner;
    this.activityIndex = options.activityIndex;
    this.bufferStore = options.bufferStore;
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

                  const historyKey = resolveHistoryKey(mergedWithTrace);

                  const profileResult = await batchSpan(
                    "update_user_profile",
                    async () =>
                      this.updateUserProfileFromMessages(
                        sessionInfo!,
                        buffered,
                        mergedWithTrace,
                      ),
                    { bufferedCount: buffered.length },
                  );
                  sessionInfo = profileResult.sessionInfo;

                  if (profileResult.quickReply) {
                    const auditedOutput = redactSensitiveText(
                      profileResult.quickReply,
                    );
                    await batchSpan("send_response", async () =>
                      this.sendResponse(mergedWithTrace, auditedOutput),
                    );
                    await batchSpan("append_history", async () =>
                      this.appendHistoryFromJob(
                        sessionInfo!,
                        mergedWithTrace,
                        historyKey,
                        undefined,
                        undefined,
                        auditedOutput,
                      ),
                    );
                    await batchSpan("record_activity", async () =>
                      this.recordActivity(sessionInfo!, log),
                    );
                    return;
                  }

                  const stopTyping = this.startTyping(mergedWithTrace, log);
                  try {
                    const { history, request } = await this.buildPromptContext(
                      jobData.groupId,
                      sessionInfo!,
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
                          request,
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
    promptInput: string,
    telemetry?: {
      traceId: string;
      jobId: string;
      logger: Logger;
      message: TelemetrySpanInput["message"];
    },
  ): Promise<{
    history: HistoryEntry[];
    request: OpencodeRequestSpec;
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

    const groupConfig = await span("load_group_config", async () =>
      this.getGroupConfig(groupId),
    );
    const agentPrompt = await span("load_agent_prompt", async () =>
      this.getAgentPrompt(groupId),
    );

    await span("ensure_opencode_skills", async () =>
      ensureOpencodeSkills({
        workspacePath: sessionInfo.workspacePath,
        groupId: sessionInfo.meta.groupId,
        botId: sessionInfo.meta.botId,
      }),
    );

    const baseSystemPrompt = buildSystemPrompt(agentPrompt);
    const userProfilePrompt = buildUserProfilePrompt(sessionInfo.meta);
    const systemPrompt = userProfilePrompt
      ? `${baseSystemPrompt}\n\n${userProfilePrompt}`
      : baseSystemPrompt;
    const system = buildOpencodeSystemContext({
      systemPrompt,
      history: [],
    });
    const resolvedInput = resolveSessionInput(promptInput);
    const rawUserText = resolvedInput.trim();
    const userText = rawUserText
      ? appendInputAuditIfSuspicious(rawUserText)
      : " ";

    const config = getConfig();
    const promptBytes =
      Buffer.byteLength(system, "utf8") + Buffer.byteLength(userText, "utf8");
    if (promptBytes > config.OPENCODE_PROMPT_MAX_BYTES) {
      throw new Error(
        `Prompt size ${promptBytes} exceeds OPENCODE_PROMPT_MAX_BYTES=${config.OPENCODE_PROMPT_MAX_BYTES}`,
      );
    }

    const sessionTitle = buildOpencodeSessionTitle(sessionInfo);
    const opencodeSessionId = await span(
      "ensure_opencode_session",
      async () =>
        this.ensureOpencodeSessionId(sessionInfo, sessionTitle, telemetry),
      {
        hasSessionId: Boolean(sessionInfo.meta.opencodeSessionId),
      },
    );

    const request: OpencodeRequestSpec = {
      directory: sessionInfo.workspacePath,
      sessionId: opencodeSessionId,
      body: {
        system,
        model: resolveModelRef({
          groupOverride: groupConfig.model,
          openaiBaseUrl: config.OPENAI_BASE_URL,
          openaiApiKey: config.OPENAI_API_KEY,
          modelsCsv: config.OPENCODE_MODELS,
        }),
        tools: config.OPENCODE_YOLO ? YOLO_TOOLS : undefined,
        parts: [{ type: "text", text: userText }],
      },
    };

    return { history: [], request };
  }

  private async ensureOpencodeSessionId(
    sessionInfo: SessionInfo,
    title: string,
    telemetry?: {
      logger: Logger;
      traceId: string;
      jobId: string;
      message: TelemetrySpanInput["message"];
    },
  ): Promise<string> {
    const directory = sessionInfo.workspacePath;
    const existing = sessionInfo.meta.opencodeSessionId?.trim();

    const log = telemetry?.logger ?? this.logger;
    if (existing && isLikelyOpencodeSessionId(existing)) {
      const found = await this.opencodeClient.getSession({
        directory,
        sessionId: existing,
      });
      if (found) {
        return existing;
      }
      log.warn(
        { sessionId: sessionInfo.meta.sessionId, opencodeSessionId: existing },
        "Opencode session not found; creating a new one",
      );
    }

    const created = await this.opencodeClient.createSession({
      directory,
      title,
    });
    const createdId = created.id?.trim();
    if (!createdId || !isLikelyOpencodeSessionId(createdId)) {
      throw new Error("Opencode returned an invalid session id");
    }

    const now = new Date().toISOString();
    const updated = await this.sessionRepository.updateMeta({
      ...sessionInfo.meta,
      opencodeSessionId: createdId,
      updatedAt: now,
    });
    sessionInfo.meta = updated.meta;
    return createdId;
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

  private async updateUserProfileFromMessages(
    sessionInfo: SessionInfo,
    buffered: ReadonlyArray<SessionEvent>,
    latest: SessionEvent,
  ): Promise<{ sessionInfo: SessionInfo; quickReply?: string }> {
    const currentOwnerName = sessionInfo.meta.ownerName?.trim() ?? "";
    const currentPreferredName = sessionInfo.meta.preferredName?.trim() ?? "";
    const observedOwnerName = resolveUserDisplayName(latest);

    let observedPreferredName: string | null = null;
    let renameInstructionCount = 0;
    for (const message of buffered) {
      const candidate = extractPreferredNameInstruction(message.content);
      if (!candidate) {
        continue;
      }
      renameInstructionCount += 1;
      observedPreferredName = candidate;
    }

    const shouldUpdateOwnerName =
      Boolean(observedOwnerName) && observedOwnerName !== currentOwnerName;
    const shouldUpdatePreferredName =
      Boolean(observedPreferredName) &&
      observedPreferredName !== currentPreferredName;

    let updatedSessionInfo = sessionInfo;
    if (shouldUpdateOwnerName || shouldUpdatePreferredName) {
      const updatedAt = new Date().toISOString();
      updatedSessionInfo = await this.sessionRepository.updateMeta({
        ...sessionInfo.meta,
        ownerName: shouldUpdateOwnerName
          ? (observedOwnerName ?? undefined)
          : sessionInfo.meta.ownerName,
        preferredName: shouldUpdatePreferredName
          ? (observedPreferredName ?? undefined)
          : sessionInfo.meta.preferredName,
        updatedAt,
      });
    }

    if (renameInstructionCount === 0 || !observedPreferredName) {
      return { sessionInfo: updatedSessionInfo };
    }

    const isRenameOnlyBatch = buffered.every(
      (message) => extractPreferredNameInstruction(message.content) !== null,
    );
    if (!isRenameOnlyBatch) {
      return { sessionInfo: updatedSessionInfo };
    }

    return {
      sessionInfo: updatedSessionInfo,
      quickReply: `好的，以后叫你${observedPreferredName}。`,
    };
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

function buildUserProfilePrompt(meta: SessionInfo["meta"]): string | null {
  const preferredName = meta.preferredName?.trim();
  const ownerName = meta.ownerName?.trim();
  if (!preferredName && !ownerName) {
    return null;
  }

  const lines = ["用户信息："];
  if (preferredName) {
    lines.push(`- 用户希望的称呼：${preferredName}`);
  }
  if (ownerName) {
    lines.push(`- 平台用户名：${ownerName}`);
  }

  const effectiveName = preferredName ?? ownerName;
  if (effectiveName) {
    lines.push(`称呼用户时优先使用“${effectiveName}”。`);
  }
  return lines.join("\n");
}

function resolveUserDisplayName(session: SessionEvent): string | null {
  if (session.platform === "discord") {
    if (!session.extras || typeof session.extras !== "object") {
      return null;
    }
    const extras = session.extras as Record<string, unknown>;
    const authorName = extras["authorName"];
    if (typeof authorName === "string" && authorName.trim()) {
      return authorName.trim();
    }
    return null;
  }

  if (session.platform === "qq") {
    if (!session.extras || typeof session.extras !== "object") {
      return null;
    }
    const extras = session.extras as Record<string, unknown>;
    const sender = extras["sender"];
    if (!sender || typeof sender !== "object") {
      return null;
    }
    const senderRecord = sender as Record<string, unknown>;
    const card = senderRecord["card"];
    if (typeof card === "string" && card.trim()) {
      return card.trim();
    }
    const nickname = senderRecord["nickname"];
    if (typeof nickname === "string" && nickname.trim()) {
      return nickname.trim();
    }
    return null;
  }

  return null;
}

function extractPreferredNameInstruction(content: string): string | null {
  const normalized = normalizeRenameText(content);
  if (!normalized) {
    return null;
  }

  const patterns: RegExp[] = [
    /^(?:以后|今后|从现在起|从现在开始|以后请|请|麻烦|以后麻烦)?(?:都)?(?:叫我|称呼我|喊我)\s*([^，。,.!?\n]{1,32})[，。,.!?]*$/u,
    /^(?:我叫|我是)\s*([^，。,.!?\n]{1,32})[，。,.!?]*$/u,
    /^(?:把我叫做|把我称呼为|把我称作)\s*([^，。,.!?\n]{1,32})[，。,.!?]*$/u,
  ];
  for (const pattern of patterns) {
    const match = normalized.match(pattern);
    if (!match) {
      continue;
    }
    const name = normalizePreferredName(match[1] ?? "");
    if (!name) {
      return null;
    }
    if (name.length > 32) {
      return null;
    }
    return name;
  }

  return null;
}

function normalizeRenameText(content: string): string {
  let text = content.trim();
  if (!text) {
    return "";
  }
  text = text.replace(/^#\d+\s*/u, "");
  text = text.replace(/^(?:奈塔|小捏)(?:[,，:：\s]+|$)/u, "");
  return text.trim();
}

function normalizePreferredName(value: string): string {
  let name = value.trim();
  if (!name) {
    return "";
  }

  const wrappers: Array<[string, string]> = [
    ["“", "”"],
    ["‘", "’"],
    ["「", "」"],
    ["『", "』"],
    ["【", "】"],
    ['"', '"'],
    ["'", "'"],
    ["（", "）"],
    ["(", ")"],
  ];
  for (const [open, close] of wrappers) {
    if (name.startsWith(open) && name.endsWith(close) && name.length > 1) {
      name = name.slice(open.length, name.length - close.length).trim();
    }
  }

  return name;
}

const YOLO_TOOLS: Record<string, boolean> = {
  bash: true,
  read: true,
  write: true,
  edit: true,
  list: true,
  glob: true,
  grep: true,
  webfetch: true,
  task: true,
  todowrite: true,
  todoread: true,
};

function resolveModelRef(
  input: Readonly<{
    groupOverride: string | undefined;
    openaiBaseUrl: string | undefined;
    openaiApiKey: string | undefined;
    modelsCsv: string | undefined;
  }>,
): { providerID: string; modelID: string } {
  const externalBaseUrl = input.openaiBaseUrl?.trim();
  const externalApiKey = input.openaiApiKey?.trim();
  const modelsCsv = input.modelsCsv?.trim();
  const externalModeEnabled = Boolean(
    externalBaseUrl && externalApiKey && modelsCsv,
  );
  if (!externalModeEnabled) {
    return { providerID: "opencode", modelID: "glm-4.7-free" };
  }

  const allowed = parseModelsCsv(modelsCsv!);
  if (allowed.length === 0) {
    throw new Error("OPENCODE_MODELS must include at least one model name");
  }
  const requested = sanitizeModelOverride(input.groupOverride);
  const selected =
    (requested && allowed.includes(requested) && requested) || allowed[0];
  return { providerID: "litellm", modelID: selected };
}

function parseModelsCsv(value: string): string[] {
  const models = value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  return Array.from(new Set(models));
}

function sanitizeModelOverride(value: string | undefined): string | null {
  if (!value) {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  return trimmed;
}

function buildOpencodeSessionTitle(sessionInfo: SessionInfo): string {
  const groupId = sessionInfo.meta.groupId;
  const location = groupId === "0" ? "dm:0" : `group:${groupId}`;
  return `${location} user:${sessionInfo.meta.ownerId} bot:${sessionInfo.meta.botId} sid:${sessionInfo.meta.sessionId} key:${sessionInfo.meta.key}`;
}

function isLikelyOpencodeSessionId(value: string): boolean {
  return (
    /^ses_[0-9a-f]{12}[A-Za-z0-9]{14}$/.test(value) || value.startsWith("ses_")
  );
}
