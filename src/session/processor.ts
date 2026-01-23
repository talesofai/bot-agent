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
import { runSessionGateLoop } from "./gate-loop";
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

type SessionProcessorSpan = <T>(
  step: string,
  fn: () => Promise<T>,
  attrs?: Record<string, unknown>,
) => Promise<T>;

type SessionProcessorRuntime = {
  job: SessionJobContext;
  jobData: SessionJobData;
  traceId: string;
  jobId: string;
  log: Logger;
  spanMessage: NonNullable<TelemetrySpanInput["message"]>;
  span: SessionProcessorSpan;
  bufferKey: SessionBufferKey;
  gateToken: string;
};

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

    const runtime: SessionProcessorRuntime = {
      job,
      jobData,
      traceId,
      jobId,
      log,
      spanMessage,
      span,
      bufferKey: toBufferKey(jobData),
      gateToken: jobData.gateToken,
    };

    await span("job_process", async () => this.runJob(runtime), {
      traceStartedAt: jobData.traceStartedAt,
      enqueuedAt: jobData.enqueuedAt,
      queueDelayMs,
      e2eAgeMs,
    });
  }

  private async runJob(runtime: SessionProcessorRuntime): Promise<void> {
    let statusUpdated = false;
    let sessionInfo: SessionInfo | null = null;
    let shouldSetIdle = true;

    try {
      const gateOk = await runtime.span("gate_claim_initial", async () =>
        this.bufferStore.claimGate(runtime.bufferKey, runtime.gateToken),
      );
      if (!gateOk) {
        runtime.log.debug("Skipping session job due to gate token mismatch");
        return;
      }

      const gateResult = await runSessionGateLoop({
        bufferStore: this.bufferStore,
        bufferKey: runtime.bufferKey,
        gateToken: runtime.gateToken,
        logger: runtime.log,
        onBatch: async (buffered) => {
          try {
            return await withTelemetrySpan(
              runtime.log,
              {
                traceId: runtime.traceId,
                phase: "worker",
                step: "process_batch",
                component: "session-processor",
                message: runtime.spanMessage,
                job: { id: runtime.jobId },
                attrs: { bufferedCount: buffered.length },
              },
              async () => {
                if (!sessionInfo) {
                  sessionInfo = await runtime.span("ensure_session", async () =>
                    this.ensureSession(
                      runtime.jobData.botId,
                      runtime.jobData.groupId,
                      runtime.jobData.userId,
                      runtime.jobData.key,
                      runtime.jobData.sessionId,
                    ),
                  );
                  await runtime.span("record_activity", async () =>
                    this.recordActivity(sessionInfo!, runtime.log),
                  );
                  sessionInfo = await runtime.span(
                    "update_status_running",
                    async () => this.updateStatus(sessionInfo!, "running"),
                  );
                  statusUpdated = true;
                  await runtime.span("record_activity", async () =>
                    this.recordActivity(sessionInfo!, runtime.log),
                  );
                }

                return this.handleBatch(runtime, sessionInfo!, buffered);
              },
            );
          } catch (err) {
            runtime.log.error(
              { err },
              "Failed to process buffered session messages; requeuing",
            );
            try {
              await this.bufferStore.requeueFront(runtime.bufferKey, buffered);
            } catch (requeueErr) {
              runtime.log.error(
                { err: requeueErr },
                "Failed to requeue buffered messages after error",
              );
            }
            throw err;
          }
        },
      });

      if (gateResult === "lost_gate") {
        shouldSetIdle = false;
      }
    } catch (err) {
      runtime.log.error({ err }, "Error processing session job");
      throw err;
    } finally {
      if (statusUpdated && sessionInfo && shouldSetIdle) {
        try {
          await this.updateStatus(sessionInfo, "idle");
        } catch (err) {
          runtime.log.warn({ err }, "Failed to update session status to idle");
        }
      }
    }
  }

  private async handleBatch(
    runtime: SessionProcessorRuntime,
    sessionInfo: SessionInfo,
    buffered: SessionEvent[],
  ): Promise<"continue" | "lost_gate"> {
    const { mergedSession, promptInput } = buildBufferedInput(buffered);
    const mergedWithTrace: SessionEvent = {
      ...mergedSession,
      extras: setTraceIdOnExtras(mergedSession.extras, runtime.traceId),
    };

    const batchMessage = {
      ...runtime.spanMessage,
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
        runtime.log,
        {
          traceId: runtime.traceId,
          phase: "worker",
          step,
          component: "session-processor",
          message: batchMessage,
          job: { id: runtime.jobId },
          attrs,
        },
        fn,
      );

    const historyKey = resolveHistoryKey(mergedWithTrace);
    const stopTyping = this.startTyping(mergedWithTrace, runtime.log);
    try {
      const { history, request } = await this.buildPromptContext(
        runtime.jobData.groupId,
        sessionInfo,
        promptInput,
        {
          traceId: runtime.traceId,
          jobId: runtime.jobId,
          logger: runtime.log,
          message: batchMessage,
        },
      );

      const result = await batchSpan(
        "opencode_run",
        async () =>
          this.runner.run({
            job: this.mapJob(runtime.job),
            session: sessionInfo,
            history,
            request,
          }),
        { historyEntries: history.length },
      );

      const stillOwnerAfterRun = await this.bufferStore.claimGate(
        runtime.bufferKey,
        runtime.gateToken,
      );
      if (!stillOwnerAfterRun) {
        runtime.log.warn(
          "Discarding session result due to gate token mismatch after run",
        );
        try {
          await this.bufferStore.requeueFront(runtime.bufferKey, buffered);
        } catch (err) {
          runtime.log.error(
            { err },
            "Failed to requeue buffered messages after gate loss",
          );
        }
        return "lost_gate";
      }

      const output = resolveOutput(result.output);
      const auditedOutput = output ? redactSensitiveText(output) : undefined;

      await batchSpan("send_response", async () =>
        this.sendResponse(mergedWithTrace, auditedOutput),
      );
      await batchSpan("append_history", async () =>
        this.appendHistoryFromJob(
          sessionInfo,
          mergedWithTrace,
          historyKey,
          result.historyEntries?.filter((entry) => entry.role !== "assistant"),
          result.streamEvents,
          auditedOutput,
          { stdout: result.rawStdout, stderr: result.rawStderr },
        ),
      );
      await batchSpan("record_activity", async () =>
        this.recordActivity(sessionInfo, runtime.log),
      );

      return "continue";
    } finally {
      stopTyping();
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
    const systemPrompt = buildSystemPrompt(agentPrompt);
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
