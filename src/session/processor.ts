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
import type { OpencodeStreamEvent } from "../opencode/output";
import type { OpencodeToolCall } from "../opencode/output";
import type { OpencodeRequestSpec, OpencodeRunner } from "../worker/runner";
import type { SessionActivityIndex } from "./activity-store";
import type { SessionBuffer, SessionBufferKey } from "./buffer";
import { runSessionGateLoop } from "./gate-loop";
import {
  extractOutputElements,
  type CommandActionSuggestion,
} from "./output-elements";
import { redactSensitiveText } from "../utils/redact";
import type { OpencodeClient } from "../opencode/server-client";
import { appendInputAuditIfSuspicious } from "../opencode/input-audit";
import { ensureOpencodeSkills } from "../opencode/skills";
import { getConfig } from "../config";
import { WorldFileStore } from "../world/file-store";
import { parseWorldGroup } from "../world/ids";
import { WorldStore } from "../world/store";
import { feishuLogJson } from "../feishu/webhook";
import { parseCharacterGroup } from "../character/ids";
import {
  UserStateStore,
  type UserCommandTranscript,
  type UserLanguage,
} from "../user/state-store";
import {
  buildLanguageDirective,
  buildSessionOpencodeRunFailedReply,
  buildSessionOpencodeResumePrompt,
  buildSessionPromptContextFailedReply,
  buildSystemPrompt,
} from "../texts";
import {
  type TelemetrySpanInput,
  resolveTraceId,
  setTraceIdOnExtras,
  withTelemetrySpan,
} from "../telemetry";
import {
  buildOpencodeSessionTitle,
  classifyOpencodeTimeoutPoint,
  isAbortError,
  isLikelyOpencodeSessionId,
  parseWebfetchStatusCode,
  readHttpStatusCode,
  resolveHistoryKey,
  resolveModelRef,
  resolveOpencodeAssistantMessageId,
  resolveOutput,
  resolveSessionInput,
  resolveSessionTools,
  resolveUserCreatedAt,
  toBufferKey,
  truncateLogPreview,
  truncateTextByBytes,
} from "./processor-utils";
import {
  ensureWorkspaceBindingsWithDeps,
  syncWorkspaceFilesFromWorkspaceWithDeps,
} from "./processor-workspace";

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
  private worldStore: WorldStore;
  private worldFiles: WorldFileStore;
  private userState: UserStateStore;

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

    const config = getConfig();
    this.worldStore = new WorldStore({
      redisUrl: config.REDIS_URL,
      logger: this.logger,
    });
    this.worldFiles = new WorldFileStore({ logger: this.logger });
    this.userState = new UserStateStore({ logger: this.logger });
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
      let promptContext: {
        history: HistoryEntry[];
        request: OpencodeRequestSpec;
        promptBytes: number;
        language: UserLanguage | null;
      };
      try {
        promptContext = await this.buildPromptContext(
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
      } catch (err) {
        const errMessage = err instanceof Error ? err.message : String(err);
        const isAbort = isAbortError(err);

        runtime.log.warn(
          { err, isAbort },
          "Failed to build opencode prompt context",
        );
        feishuLogJson({
          event: "log.warn",
          traceId: runtime.traceId,
          platform: mergedWithTrace.platform,
          guildId: mergedWithTrace.guildId,
          channelId: mergedWithTrace.channelId,
          messageId: mergedWithTrace.messageId,
          groupId: sessionInfo.meta.groupId,
          sessionId: sessionInfo.meta.sessionId,
          userId: sessionInfo.meta.ownerId,
          key: sessionInfo.meta.key,
          component: "session-processor",
          step: "build_prompt_context",
          msg: `构建opencode上下文失败 abort:${isAbort}`,
          errName: err instanceof Error ? err.name : undefined,
          errMessage,
        });

        if (isAbort) {
          try {
            const nowIso = new Date().toISOString();
            const updated = await this.sessionRepository.updateMeta({
              ...sessionInfo.meta,
              opencodeSessionId: undefined,
              opencodeLastAssistantMessageId: undefined,
              updatedAt: nowIso,
            });
            sessionInfo.meta = updated.meta;
          } catch (metaErr) {
            runtime.log.warn(
              { err: metaErr },
              "Failed to reset opencodeSessionId after prompt context failure",
            );
          }
        }

        const language = await this.userState
          .getLanguage(sessionInfo.meta.ownerId)
          .catch(() => null);
        const responseOutput = buildSessionPromptContextFailedReply(language);
        try {
          await batchSpan(
            "send_response",
            async () => this.sendResponse(mergedWithTrace, responseOutput),
            {
              outputBytes: Buffer.byteLength(responseOutput, "utf8"),
              outputPreview: responseOutput,
              outputPreviewTruncated: false,
              promptContextBuildFailed: true,
            },
          );
        } catch (sendErr) {
          runtime.log.error(
            { err: sendErr },
            "Failed to send fallback response",
          );
        }
        await batchSpan("append_history", async () =>
          this.appendHistoryFromJob(
            sessionInfo,
            mergedWithTrace,
            historyKey,
            undefined,
            undefined,
            responseOutput,
            { stderr: errMessage },
          ),
        );
        await batchSpan("record_activity", async () =>
          this.recordActivity(sessionInfo, runtime.log),
        );

        return "continue";
      }

      const { history, request, promptBytes, language } = promptContext;

      const parsedWorld = parseWorldGroup(sessionInfo.meta.groupId);
      const parsedCharacter = parseCharacterGroup(sessionInfo.meta.groupId);
      feishuLogJson({
        event: "ai.start",
        traceId: runtime.traceId,
        platform: mergedWithTrace.platform,
        guildId: mergedWithTrace.guildId,
        channelId: mergedWithTrace.channelId,
        messageId: mergedWithTrace.messageId,
        groupId: sessionInfo.meta.groupId,
        sessionId: sessionInfo.meta.sessionId,
        userId: sessionInfo.meta.ownerId,
        key: sessionInfo.meta.key,
        worldId: parsedWorld?.worldId,
        characterId: parsedCharacter?.characterId,
      });

      const resumePrompt = buildSessionOpencodeResumePrompt(language).trim();
      const resumeParts = [{ type: "text" as const, text: resumePrompt }];

      let result: Awaited<ReturnType<OpencodeRunner["run"]>> | null = null;
      const maxRunAttempts = 3;
      const originalParts = request.body.parts;
      let promptMode: "original" | "resume" = "original";

      let lastError: {
        errName?: string;
        errMessage: string;
        status: number | null;
        isAbort: boolean;
      } | null = null;

      for (let runAttempt = 1; runAttempt <= maxRunAttempts; runAttempt += 1) {
        const isFinalAttempt = runAttempt === maxRunAttempts;
        const isResumeAttempt = promptMode === "resume";
        request.body.parts = isResumeAttempt ? resumeParts : originalParts;
        try {
          result = await batchSpan(
            "opencode_run",
            async () =>
              this.runner.run({
                job: this.mapJob(runtime.job),
                session: sessionInfo,
                history,
                request,
                language,
              }),
            {
              historyEntries: history.length,
              promptBytes,
              modelProvider: request.body.model?.providerID,
              modelId: request.body.model?.modelID,
              attempt: runAttempt,
            },
          );
          const output = resolveOutput(result.output);
          const assistantMessageId = resolveOpencodeAssistantMessageId(result);
          const isStaleReply =
            Boolean(output) &&
            Boolean(assistantMessageId) &&
            assistantMessageId ===
              sessionInfo.meta.opencodeLastAssistantMessageId;
          if (isStaleReply) {
            lastError = {
              errMessage: "opencode_stale_assistant_message",
              status: null,
              isAbort: false,
            };
            promptMode = "resume";
            feishuLogJson({
              event: "log.warn",
              traceId: runtime.traceId,
              platform: mergedWithTrace.platform,
              guildId: mergedWithTrace.guildId,
              channelId: mergedWithTrace.channelId,
              messageId: mergedWithTrace.messageId,
              groupId: sessionInfo.meta.groupId,
              sessionId: sessionInfo.meta.sessionId,
              userId: sessionInfo.meta.ownerId,
              key: sessionInfo.meta.key,
              worldId: parsedWorld?.worldId,
              characterId: parsedCharacter?.characterId,
              component: "session-processor",
              step: "opencode_run",
              msg: `opencode返回了上一条assistant消息（疑似未处理本次输入） attempt:${runAttempt}/${maxRunAttempts}`,
              errName: "StaleAssistantMessage",
              errMessage: `assistantMessageId=${assistantMessageId} lastAssistantMessageId=${sessionInfo.meta.opencodeLastAssistantMessageId}`,
            });
            if (!isFinalAttempt) {
              continue;
            }
            result = null;
            break;
          }
          if (output) {
            break;
          }

          lastError = {
            errMessage: "opencode_no_output",
            status: null,
            isAbort: false,
          };
          promptMode = "resume";
          feishuLogJson({
            event: "log.warn",
            traceId: runtime.traceId,
            platform: mergedWithTrace.platform,
            guildId: mergedWithTrace.guildId,
            channelId: mergedWithTrace.channelId,
            messageId: mergedWithTrace.messageId,
            groupId: sessionInfo.meta.groupId,
            sessionId: sessionInfo.meta.sessionId,
            userId: sessionInfo.meta.ownerId,
            key: sessionInfo.meta.key,
            worldId: parsedWorld?.worldId,
            characterId: parsedCharacter?.characterId,
            component: "session-processor",
            step: "opencode_run",
            msg: `opencode无输出 attempt:${runAttempt}/${maxRunAttempts}`,
          });
          if (!isFinalAttempt) {
            continue;
          }
          result = null;
          break;
        } catch (err) {
          const errMessage = err instanceof Error ? err.message : String(err);
          const errName = err instanceof Error ? err.name : undefined;
          const isAbort = isAbortError(err);
          const status = readHttpStatusCode(err);
          const shouldResetOpencodeSession = status === 404;
          lastError = { errName, errMessage, status, isAbort };
          const timeoutPoint = classifyOpencodeTimeoutPoint({
            errName,
            errMessage,
            status,
          });
          const timeoutHint = timeoutPoint ? ` timeout:${timeoutPoint}` : "";

          feishuLogJson({
            event: "log.warn",
            traceId: runtime.traceId,
            platform: mergedWithTrace.platform,
            guildId: mergedWithTrace.guildId,
            channelId: mergedWithTrace.channelId,
            messageId: mergedWithTrace.messageId,
            groupId: sessionInfo.meta.groupId,
            sessionId: sessionInfo.meta.sessionId,
            userId: sessionInfo.meta.ownerId,
            key: sessionInfo.meta.key,
            worldId: parsedWorld?.worldId,
            characterId: parsedCharacter?.characterId,
            component: "session-processor",
            step: "opencode_run",
            msg: `opencode失败${timeoutHint} attempt:${runAttempt}/${maxRunAttempts} abort:${isAbort} status:${status ?? "n/a"}`,
            timeoutPoint: timeoutPoint ?? undefined,
            errName,
            errMessage,
          });

          if (!isFinalAttempt) {
            runtime.log.debug(
              { err, attempt: runAttempt, status },
              "Opencode run failed; retrying",
            );
            if (shouldResetOpencodeSession) {
              const nowIso = new Date().toISOString();
              const cleared = await this.sessionRepository.updateMeta({
                ...sessionInfo.meta,
                opencodeSessionId: undefined,
                opencodeLastAssistantMessageId: undefined,
                updatedAt: nowIso,
              });
              sessionInfo.meta = cleared.meta;
              const newId = await this.ensureOpencodeSessionId(
                sessionInfo,
                buildOpencodeSessionTitle(sessionInfo),
                {
                  logger: runtime.log,
                  traceId: runtime.traceId,
                  jobId: runtime.jobId,
                  message: runtime.spanMessage,
                },
              );
              request.sessionId = newId;
            }
            if (isAbort) {
              promptMode = "resume";
            }
            continue;
          }

          runtime.log.warn(
            {
              err,
              attempt: runAttempt,
              status,
            },
            "Opencode run failed",
          );

          if (shouldResetOpencodeSession) {
            const nowIso = new Date().toISOString();
            const cleared = await this.sessionRepository.updateMeta({
              ...sessionInfo.meta,
              opencodeSessionId: undefined,
              opencodeLastAssistantMessageId: undefined,
              updatedAt: nowIso,
            });
            sessionInfo.meta = cleared.meta;
          }

          result = null;
          break;
        }
      }

      if (!result) {
        const timeoutPoint = classifyOpencodeTimeoutPoint({
          errName: lastError?.errName,
          errMessage: lastError?.errMessage ?? "",
          status: lastError?.status ?? null,
        });
        const timeoutHint = timeoutPoint ? ` timeout:${timeoutPoint}` : "";
        feishuLogJson({
          event: "log.error",
          traceId: runtime.traceId,
          platform: mergedWithTrace.platform,
          guildId: mergedWithTrace.guildId,
          channelId: mergedWithTrace.channelId,
          messageId: mergedWithTrace.messageId,
          groupId: sessionInfo.meta.groupId,
          sessionId: sessionInfo.meta.sessionId,
          userId: sessionInfo.meta.ownerId,
          key: sessionInfo.meta.key,
          worldId: parsedWorld?.worldId,
          characterId: parsedCharacter?.characterId,
          component: "session-processor",
          step: "opencode_run",
          msg: `opencode最终失败${timeoutHint} attempts:${maxRunAttempts}`,
          timeoutPoint: timeoutPoint ?? undefined,
          errName: lastError?.errName,
          errMessage: lastError?.errMessage ?? "unknown",
        });

        try {
          const syncResult = await batchSpan(
            "sync_workspace_files",
            async () => {
              try {
                const changed =
                  await this.syncWorkspaceFilesFromWorkspace(sessionInfo);
                return { ok: true as const, changed };
              } catch (err) {
                return { ok: false as const, err };
              }
            },
          );
          if (!syncResult.ok) {
            runtime.log.error(
              { err: syncResult.err },
              "Workspace file sync failed",
            );
          }
        } catch (syncErr) {
          runtime.log.error({ err: syncErr }, "Workspace file sync failed");
        }

        const shouldReplyOnFailure = !lastError?.isAbort;
        const responseOutput = shouldReplyOnFailure
          ? buildSessionOpencodeRunFailedReply(language)
          : undefined;
        const responseOutputBytes = responseOutput
          ? Buffer.byteLength(responseOutput, "utf8")
          : 0;
        const responseOutputPreview = responseOutput
          ? truncateTextByBytes(responseOutput, 2000)
          : { content: "", truncated: false };
        if (responseOutput) {
          try {
            await batchSpan(
              "send_response",
              async () => this.sendResponse(mergedWithTrace, responseOutput),
              {
                outputBytes: responseOutputBytes,
                outputPreview: responseOutputPreview.content,
                outputPreviewTruncated: responseOutputPreview.truncated,
                opencodeRunFailed: true,
              },
            );
          } catch (sendErr) {
            runtime.log.error(
              { err: sendErr },
              "Failed to send opencode failure response",
            );
          }
        }

        feishuLogJson({
          event: "ai.finish",
          traceId: runtime.traceId,
          platform: mergedWithTrace.platform,
          guildId: mergedWithTrace.guildId,
          channelId: mergedWithTrace.channelId,
          messageId: mergedWithTrace.messageId,
          groupId: sessionInfo.meta.groupId,
          sessionId: sessionInfo.meta.sessionId,
          userId: sessionInfo.meta.ownerId,
          key: sessionInfo.meta.key,
          worldId: parsedWorld?.worldId,
          characterId: parsedCharacter?.characterId,
          outputPreview: responseOutputPreview.content,
        });
        await batchSpan("append_history", async () =>
          this.appendHistoryFromJob(
            sessionInfo,
            mergedWithTrace,
            historyKey,
            undefined,
            undefined,
            responseOutput,
            {
              stderr: lastError?.isAbort
                ? "opencode_run_aborted"
                : (lastError?.errMessage ?? "opencode_run_failed"),
            },
          ),
        );
        await batchSpan("record_activity", async () =>
          this.recordActivity(sessionInfo, runtime.log),
        );
        return "continue";
      }

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

      this.logOpencodeToolFailuresToFeishu({
        toolCalls: result.toolCalls,
        traceId: runtime.traceId,
        session: mergedWithTrace,
        sessionInfo,
        worldId: parsedWorld?.worldId,
        characterId: parsedCharacter?.characterId,
      });

      if (result.pendingUserInput?.kind === "question") {
        feishuLogJson({
          event: "log.warn",
          traceId: runtime.traceId,
          platform: mergedWithTrace.platform,
          guildId: mergedWithTrace.guildId,
          channelId: mergedWithTrace.channelId,
          messageId: mergedWithTrace.messageId,
          groupId: sessionInfo.meta.groupId,
          sessionId: sessionInfo.meta.sessionId,
          userId: sessionInfo.meta.ownerId,
          key: sessionInfo.meta.key,
          worldId: parsedWorld?.worldId,
          characterId: parsedCharacter?.characterId,
          component: "session-processor",
          step: "opencode_run",
          msg: "opencode请求用户输入（question tool）",
        });
        const nowIso = new Date().toISOString();
        const updated = await this.sessionRepository.updateMeta({
          ...sessionInfo.meta,
          opencodePendingUserInput: {
            kind: "question",
            channelId: mergedWithTrace.channelId,
            platformMessageId: mergedWithTrace.messageId,
            opencodeAssistantMessageId:
              resolveOpencodeAssistantMessageId(result),
            opencodeCallId: result.pendingUserInput.opencodeCallId,
            createdAt: nowIso,
          },
          updatedAt: nowIso,
        });
        sessionInfo.meta = updated.meta;
      } else if (sessionInfo.meta.opencodePendingUserInput) {
        const nowIso = new Date().toISOString();
        const updated = await this.sessionRepository.updateMeta({
          ...sessionInfo.meta,
          opencodePendingUserInput: undefined,
          updatedAt: nowIso,
        });
        sessionInfo.meta = updated.meta;
      }

      const responseOutput = auditedOutput;
      const syncResult = await batchSpan("sync_workspace_files", async () => {
        try {
          const changed =
            await this.syncWorkspaceFilesFromWorkspace(sessionInfo);
          return { ok: true as const, changed };
        } catch (err) {
          return { ok: false as const, err };
        }
      });
      if (!syncResult.ok) {
        runtime.log.error(
          { err: syncResult.err },
          "Workspace file sync failed",
        );
      }

      const responseOutputBytes = responseOutput
        ? Buffer.byteLength(responseOutput, "utf8")
        : 0;
      const responseOutputPreview = responseOutput
        ? truncateTextByBytes(responseOutput, 2000)
        : { content: "", truncated: false };
      await batchSpan(
        "send_response",
        async () => this.sendResponse(mergedWithTrace, responseOutput),
        {
          outputBytes: responseOutputBytes,
          outputPreview: responseOutputPreview.content,
          outputPreviewTruncated: responseOutputPreview.truncated,
        },
      );

      const assistantMessageId = resolveOpencodeAssistantMessageId(result);
      if (assistantMessageId) {
        try {
          const nowIso = new Date().toISOString();
          const updated = await this.sessionRepository.updateMeta({
            ...sessionInfo.meta,
            opencodeLastAssistantMessageId: assistantMessageId,
            updatedAt: nowIso,
          });
          sessionInfo.meta = updated.meta;
        } catch (err) {
          runtime.log.warn(
            { err, assistantMessageId },
            "Failed to persist opencode assistant message id",
          );
        }
      }
      feishuLogJson({
        event: "ai.finish",
        traceId: runtime.traceId,
        platform: mergedWithTrace.platform,
        guildId: mergedWithTrace.guildId,
        channelId: mergedWithTrace.channelId,
        messageId: mergedWithTrace.messageId,
        groupId: sessionInfo.meta.groupId,
        sessionId: sessionInfo.meta.sessionId,
        userId: sessionInfo.meta.ownerId,
        key: sessionInfo.meta.key,
        worldId: parsedWorld?.worldId,
        characterId: parsedCharacter?.characterId,
        outputPreview: responseOutputPreview.content,
      });
      await batchSpan("append_history", async () =>
        this.appendHistoryFromJob(
          sessionInfo,
          mergedWithTrace,
          historyKey,
          result.historyEntries?.filter((entry) => entry.role !== "assistant"),
          result.streamEvents,
          responseOutput,
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
    await this.worldStore.close();
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
    promptBytes: number;
    language: UserLanguage | null;
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

    const language = await span("resolve_user_language", async () =>
      this.userState.getLanguage(sessionInfo.meta.ownerId),
    );
    const groupConfig = await span("load_group_config", async () =>
      this.getGroupConfig(groupId),
    );
    const agentPrompt = await span("load_agent_prompt", async () =>
      this.getAgentPrompt(groupId, language),
    );

    await span("ensure_workspace_bindings", async () =>
      this.ensureWorkspaceBindings(sessionInfo),
    );

    await span("ensure_opencode_skills", async () =>
      ensureOpencodeSkills({
        workspacePath: sessionInfo.workspacePath,
        groupId: sessionInfo.meta.groupId,
        botId: sessionInfo.meta.botId,
      }),
    );
    const resolvedInput = resolveSessionInput(promptInput);
    const rawUserText = resolvedInput.trim();
    const recentCommandTranscripts = await span(
      "load_command_transcripts",
      async () =>
        this.userState.getRecentCommandTranscripts(sessionInfo.meta.ownerId, 8),
    );
    const systemPrompt = buildSystemPrompt(agentPrompt, language);
    const system = buildOpencodeSystemContext({
      systemPrompt,
      history: [],
    });
    const languageDirective = buildLanguageDirective(language);
    const commandTranscriptContext = this.buildCommandTranscriptContext(
      recentCommandTranscripts,
      language,
    );
    const rawWithTranscriptContext = commandTranscriptContext
      ? `${commandTranscriptContext}\n\n${rawUserText}`.trim()
      : rawUserText;
    const rawWithLanguage = languageDirective
      ? `${rawWithTranscriptContext}\n\n${languageDirective}`.trim()
      : rawWithTranscriptContext;
    const userText = rawWithLanguage
      ? appendInputAuditIfSuspicious(rawWithLanguage, language)
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
        tools: config.OPENCODE_YOLO
          ? resolveSessionTools(sessionInfo.meta.groupId)
          : undefined,
        parts: [{ type: "text", text: userText }],
      },
    };

    return { history: [], request, promptBytes, language };
  }

  private async ensureWorkspaceBindings(
    sessionInfo: SessionInfo,
  ): Promise<void> {
    return ensureWorkspaceBindingsWithDeps(
      {
        worldStore: this.worldStore,
        worldFiles: this.worldFiles,
      },
      sessionInfo,
    );
  }

  private async syncWorkspaceFilesFromWorkspace(
    sessionInfo: SessionInfo,
  ): Promise<string[]> {
    return syncWorkspaceFilesFromWorkspaceWithDeps(
      {
        worldStore: this.worldStore,
        worldFiles: this.worldFiles,
      },
      sessionInfo,
    );
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

  private async getAgentPrompt(
    groupId: string,
    language: UserLanguage | null,
  ): Promise<string> {
    await this.groupRepository.ensureGroupDir(groupId);
    const groupPath = this.sessionRepository.getGroupPath(groupId);
    const agentContent = await this.groupRepository.loadAgentPromptForLanguage(
      groupPath,
      language,
    );
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
    const { content, elements, commandActions } = extractOutputElements(output);
    if (!content && elements.length === 0 && !commandActions) {
      return;
    }

    if (content || elements.length > 0) {
      await this.adapter.sendMessage(
        session,
        content,
        elements.length > 0 ? { elements } : undefined,
      );
    }

    if (commandActions && commandActions.actions.length > 0) {
      const sent = await this.sendSuggestedCommandActions(session, {
        prompt: commandActions.prompt,
        actions: commandActions.actions,
      });
      if (!sent) {
        const fallbackText = this.buildCommandActionFallbackText({
          prompt: commandActions.prompt,
          actions: commandActions.actions,
        });
        if (fallbackText) {
          await this.adapter.sendMessage(session, fallbackText);
        }
      }
    }
  }

  private buildCommandTranscriptContext(
    transcripts: UserCommandTranscript[],
    language: UserLanguage | null,
  ): string {
    if (transcripts.length === 0) {
      return "";
    }
    const header =
      language === "en"
        ? "Recent user-triggered command actions:"
        : "用户最近触发过的指令操作：";
    const lines = transcripts.map((entry, index) => {
      const command = truncateTextByBytes(entry.command.trim(), 120);
      const result = truncateTextByBytes(entry.result.trim(), 220);
      const createdAt = entry.createdAt.trim();
      return `${index + 1}. ${command} -> ${result} (${createdAt})`;
    });
    return `${header}\n${lines.join("\n")}`;
  }

  private buildCommandActionFallbackText(input: {
    prompt?: string;
    actions: CommandActionSuggestion[];
  }): string {
    if (input.actions.length === 0) {
      return "";
    }
    const prompt = input.prompt?.trim() || "你可以执行下面这些指令：";
    const lines = input.actions.map((entry) => {
      const command = this.resolveSlashCommandFromAction(entry);
      const label = entry.label?.trim();
      return label ? `- ${label}: ${command}` : `- ${command}`;
    });
    return [prompt, ...lines].join("\n");
  }

  private resolveSlashCommandFromAction(
    action: CommandActionSuggestion,
  ): string {
    if (action.action === "help") {
      return "/help";
    }
    if (action.action === "character_create") {
      return "/character create";
    }
    if (action.action === "world_create") {
      return "/world create";
    }
    if (action.action === "world_list") {
      return "/world list";
    }
    if (action.action === "world_show") {
      return action.payload ? `/world info ${action.payload}` : "/world info";
    }
    if (action.action === "character_show") {
      return action.payload
        ? `/character view ${action.payload}`
        : "/character view";
    }
    return action.payload ? `/world join ${action.payload}` : "/world join";
  }

  private async sendSuggestedCommandActions(
    session: SessionEvent,
    input: {
      prompt?: string;
      actions: CommandActionSuggestion[];
    },
  ): Promise<boolean> {
    if (session.platform !== "discord") {
      return false;
    }
    const adapter = this.adapter as PlatformAdapter & {
      sendSuggestedCommandActions?: (input: {
        session: SessionEvent;
        prompt?: string;
        actions: CommandActionSuggestion[];
      }) => Promise<boolean | void>;
    };
    if (typeof adapter.sendSuggestedCommandActions !== "function") {
      return false;
    }
    try {
      const sent = await adapter.sendSuggestedCommandActions({
        session,
        prompt: input.prompt,
        actions: input.actions,
      });
      return sent !== false;
    } catch (err) {
      this.logger.warn({ err }, "Failed to send suggested command actions");
      return false;
    }
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
          { err, messageId: session.messageId, platform: session.platform },
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

  private logOpencodeToolFailuresToFeishu(input: {
    toolCalls?: OpencodeToolCall[];
    traceId: string;
    session: SessionEvent;
    sessionInfo: SessionInfo;
    worldId?: number;
    characterId?: number;
  }): void {
    const toolCalls = input.toolCalls ?? [];
    if (toolCalls.length === 0) {
      return;
    }

    const failures = toolCalls.filter((call) => {
      if (call.tool !== "webfetch") {
        return false;
      }
      if (call.status?.toLowerCase() === "failed") {
        return true;
      }
      return Boolean(call.errorMessage?.trim());
    });
    if (failures.length === 0) {
      return;
    }

    for (const failure of failures) {
      const urls = failure.urls?.filter(Boolean) ?? [];
      const urlText = urls.length ? urls.join(", ") : "(unknown)";
      const statusCode = parseWebfetchStatusCode(failure.errorMessage);
      const statusText = statusCode ? ` status:${statusCode}` : "";
      const errText = failure.errorMessage?.trim()
        ? ` err:${truncateLogPreview(failure.errorMessage.trim(), 280)}`
        : "";

      feishuLogJson({
        event: "log.warn",
        traceId: input.traceId,
        platform: input.session.platform,
        guildId: input.session.guildId,
        channelId: input.session.channelId,
        messageId: input.session.messageId,
        groupId: input.sessionInfo.meta.groupId,
        sessionId: input.sessionInfo.meta.sessionId,
        userId: input.sessionInfo.meta.ownerId,
        worldId: input.worldId,
        characterId: input.characterId,
        msg: `webfetch失败${statusText} url:${truncateLogPreview(urlText, 500)}${errText}`,
      });
    }
  }
}
