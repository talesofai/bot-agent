import { Worker, type Job, DelayedError } from "bullmq";
import IORedis from "ioredis";
import type { Logger } from "pino";
import Redlock, { type Lock } from "redlock";

import type { ResponseQueue, SessionJob, SessionJobData } from "../queue";
import { GroupFileRepository } from "../store/repository";
import { SessionRepository } from "../session/repository";
import { HistoryStore } from "../session/history";
import { createSession } from "../session/session-ops";
import { OpencodeLauncher } from "../opencode/launcher";
import { buildOpencodePrompt } from "../opencode/prompt";
import { buildSystemPrompt } from "../opencode/system-prompt";
import type { OpencodeRunner } from "./runner";
import type { HistoryEntry, SessionInfo } from "../types/session";
import type { SessionEvent } from "../types/platform";
import { SessionActivityStore } from "../session/activity-store";
import {
  assertValidSessionKey,
  buildSessionId,
  buildSessionLockKey,
} from "../session/utils";
import { assertSafePathSegment } from "../utils/path";
import { SessionBufferStore } from "../session/buffer";

export interface SessionWorkerOptions {
  id: string;
  dataDir: string;
  redis: {
    url: string;
  };
  queue: {
    name: string;
    concurrency?: number;
    prefix?: string;
    stalledIntervalMs?: number;
    maxStalledCount?: number;
  };
  launcher?: OpencodeLauncher;
  runner: OpencodeRunner;
  logger: Logger;
  limits?: {
    historyEntries?: number;
    historyBytes?: number;
    lockTtlSeconds?: number;
    requeueDelayMs?: number;
  };
  responseQueue?: ResponseQueue;
}

export class SessionWorker {
  private worker: Worker<SessionJobData>;
  private logger: Logger;
  private groupRepository: GroupFileRepository;
  private sessionRepository: SessionRepository;
  private historyStore: HistoryStore;
  private launcher: OpencodeLauncher;
  private runner: OpencodeRunner;
  private responseQueue?: ResponseQueue;
  private activityIndex: SessionActivityStore;
  private workerConnection: IORedis;
  private lockConnection: IORedis;
  private redlock: Redlock;
  private bufferStore: SessionBufferStore;
  private historyMaxEntries?: number;
  private historyMaxBytes?: number;
  private sessionLockTtlMs: number;
  private requeueDelayMs: number;
  private stalledIntervalMs: number;
  private maxStalledCount: number;

  constructor(options: SessionWorkerOptions) {
    this.logger = options.logger.child({
      component: "session-worker",
      workerId: options.id,
    });
    this.groupRepository = new GroupFileRepository({
      dataDir: options.dataDir,
      logger: this.logger,
    });
    this.sessionRepository = new SessionRepository({
      dataDir: options.dataDir,
      logger: this.logger,
    });
    this.historyStore = new HistoryStore(this.logger);
    this.launcher = options.launcher ?? new OpencodeLauncher();
    this.runner = options.runner;
    this.responseQueue = options.responseQueue;
    this.historyMaxEntries = options.limits?.historyEntries;
    this.historyMaxBytes = options.limits?.historyBytes;
    const lockTtlSeconds = options.limits?.lockTtlSeconds ?? 600;
    this.sessionLockTtlMs = lockTtlSeconds * 1000;
    this.requeueDelayMs = options.limits?.requeueDelayMs ?? 2000;
    this.stalledIntervalMs = options.queue.stalledIntervalMs ?? 30_000;
    this.maxStalledCount = options.queue.maxStalledCount ?? 1;

    this.activityIndex = new SessionActivityStore({
      redisUrl: options.redis.url,
      logger: this.logger,
    });

    this.workerConnection = new IORedis(options.redis.url, {
      maxRetriesPerRequest: null,
    });
    this.lockConnection = new IORedis(options.redis.url, {
      maxRetriesPerRequest: null,
    });
    this.redlock = new Redlock([this.lockConnection], {
      retryCount: 0,
      retryDelay: 0,
      retryJitter: 0,
    });
    this.bufferStore = new SessionBufferStore({ redisUrl: options.redis.url });

    this.worker = new Worker<SessionJobData>(
      options.queue.name,
      async (job: Job<SessionJobData>) => {
        return this.processJob(job);
      },
      {
        connection: this.workerConnection,
        concurrency: options.queue.concurrency ?? 1,
        prefix: options.queue.prefix,
        autorun: false,
        stalledInterval: this.stalledIntervalMs,
        maxStalledCount: this.maxStalledCount,
      },
    );

    this.worker.on("error", (err) => {
      this.logger.error({ err }, "Worker error");
    });
    this.worker.on("failed", (job, err) => {
      this.logger.error({ err, jobId: job?.id }, "Job failed");
    });
  }

  async start(): Promise<void> {
    this.worker.run().catch((err) => {
      this.logger.error({ err }, "Worker run loop failed");
    });
  }

  async stop(): Promise<void> {
    await this.worker.close();
    await this.workerConnection.quit();
    await this.lockConnection.quit();
    await this.activityIndex.close();
    await this.bufferStore.close();
  }

  private async processJob(job: Job<SessionJobData>): Promise<void> {
    const { sessionId, groupId, userId, key } = this.validateJobData(job.data);
    const lockKey = buildSessionLockKey(groupId, sessionId);

    await this.withSessionLock(job, lockKey, sessionId, async (lockContext) => {
      let statusUpdated = false;
      let sessionInfo: SessionInfo | null = null;

      try {
        let buffered = await this.bufferStore.drain(sessionId);
        if (buffered.length === 0) {
          return;
        }

        // 2. Ensure Session Exists
        sessionInfo = await this.ensureSession(groupId, userId, key, sessionId);
        await this.recordActivity(sessionInfo);

        // 3. Update Status
        sessionInfo = await this.updateStatus(sessionInfo, "running");
        statusUpdated = true;
        await this.recordActivity(sessionInfo);

        while (buffered.length > 0) {
          const mergedSession = mergeBufferedMessages(buffered);

          // 4. Prepare Context
          const history = await this.historyStore.readHistory(
            sessionInfo.historyPath,
            {
              maxEntries: this.historyMaxEntries,
              maxBytes: this.historyMaxBytes,
            },
          );
          const groupConfig = await this.getGroupConfig(groupId);
          const agentPrompt = await this.getAgentPrompt(groupId);
          const systemPrompt = buildSystemPrompt(agentPrompt);
          const promptInput = resolveSessionInput(mergedSession.content);
          const prompt = buildOpencodePrompt({
            systemPrompt,
            history,
            input: promptInput,
          });
          const launchSpec = this.launcher.buildLaunchSpec(
            sessionInfo,
            prompt,
            groupConfig.model,
          );

          // 5. Run
          lockContext.assertActive();
          const result = await this.runner.run({
            job: this.mapJob(job),
            session: sessionInfo,
            history,
            launchSpec,
            signal: lockContext.signal,
          });
          lockContext.assertActive();
          const output = resolveOutput(result.output);

          // 6. Append History
          await this.appendHistoryFromJob(
            sessionInfo,
            mergedSession,
            result.historyEntries,
            output,
          );
          await this.recordActivity(sessionInfo);
          await this.enqueueResponse(mergedSession, output);

          buffered = await this.bufferStore.drain(sessionId);
          if (buffered.length === 0) {
            const pending = await this.bufferStore.consumePending(sessionId);
            if (pending) {
              buffered = await this.bufferStore.drain(sessionId);
            }
          }
        }
      } catch (err) {
        if (err instanceof DelayedError) {
          this.logger.debug({ sessionId }, "Session job delayed");
          throw err;
        }
        this.logger.error({ err, sessionId }, "Error processing session job");
        throw err;
      } finally {
        if (statusUpdated && sessionInfo && !lockContext.isLost()) {
          try {
            await this.updateStatus(sessionInfo, "idle");
          } catch (err) {
            this.logger.warn(
              { err },
              "Failed to update session status to idle",
            );
          }
        }
      }
    });
  }

  private async withSessionLock<T>(
    job: Job<SessionJobData>,
    lockKey: string,
    sessionId: string,
    fn: (context: {
      signal: AbortSignal;
      assertActive: () => void;
      isLost: () => boolean;
    }) => Promise<T>,
  ): Promise<T> {
    let lock: Lock | null = null;
    try {
      lock = await this.redlock.acquire([lockKey], this.sessionLockTtlMs);
    } catch (err) {
      if (!this.isLockBusy(err)) {
        this.logger.error({ err, lockKey }, "Failed to acquire session lock");
        throw err;
      }
      this.logger.debug({ sessionId }, "Session busy, delaying job");
      if (!job.token) {
        throw new Error("Missing BullMQ job token for requeue");
      }
      await job.moveToDelayed(Date.now() + this.requeueDelayMs, job.token);
      throw new DelayedError();
    }

    let renewTimer: ReturnType<typeof setInterval> | null = null;
    const abortController = new AbortController();
    let lockLost = false;

    const stopRenewal = () => {
      if (renewTimer) {
        clearInterval(renewTimer);
        renewTimer = null;
      }
    };

    if (lock) {
      const renewIntervalMs = Math.max(
        1000,
        Math.floor(this.sessionLockTtlMs / 2),
      );
      renewTimer = setInterval(() => {
        void (async () => {
          try {
            lock = await lock!.extend(this.sessionLockTtlMs);
          } catch (err) {
            lockLost = true;
            if (!abortController.signal.aborted) {
              abortController.abort();
            }
            stopRenewal();
            this.logger.warn(
              { err, lockKey, sessionId },
              "Session lock lost, aborting job",
            );
          }
        })();
      }, renewIntervalMs);
    }

    const context = {
      signal: abortController.signal,
      assertActive: () => {
        if (lockLost) {
          throw new Error("Session lock lost");
        }
      },
      isLost: () => lockLost,
    };

    try {
      return await fn(context);
    } finally {
      stopRenewal();
      if (lock) {
        try {
          await lock.release();
        } catch (err) {
          this.logger.warn({ err }, "Failed to release session lock");
        }
      }
    }
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
    historyEntries?: HistoryEntry[],
    output?: string,
  ): Promise<void> {
    const entries: HistoryEntry[] = [];

    const nowIso = new Date().toISOString();
    const userCreatedAt = resolveUserCreatedAt(session.timestamp, nowIso);
    // Persist a single space so downstream storage never sees an empty user input.
    const userContent = session.content.trim() ? session.content : " ";
    entries.push({
      role: "user",
      content: userContent,
      createdAt: userCreatedAt,
    });

    const nonUserEntries =
      historyEntries?.filter((entry) => entry.role !== "user") ?? [];
    if (nonUserEntries.length > 0) {
      entries.push(...nonUserEntries);
    }

    const hasAssistantEntry = nonUserEntries.some(
      (entry) => entry.role === "assistant",
    );
    if (!hasAssistantEntry && output) {
      entries.push({
        role: "assistant",
        content: output,
        createdAt: nowIso,
      });
    }

    for (const entry of entries) {
      await this.historyStore.appendHistory(sessionInfo.historyPath, entry);
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

  private async enqueueResponse(
    session: SessionEvent,
    output?: string,
  ): Promise<void> {
    if (!output || !this.responseQueue) {
      return;
    }
    try {
      await this.responseQueue.enqueue({
        content: output,
        session,
      });
    } catch (err) {
      this.logger.error(
        { err, sessionId: session.messageId },
        "Failed to enqueue response",
      );
    }
  }
  private isLockBusy(err: unknown): boolean {
    if (!(err instanceof Error)) {
      return false;
    }
    return err.name === "ExecutionError" || err.name === "ResourceLockedError";
  }

  private validateJobData(jobData: SessionJobData): SessionJobData {
    assertSafePathSegment(jobData.groupId, "groupId");
    assertSafePathSegment(jobData.userId, "userId");
    assertSafePathSegment(jobData.sessionId, "sessionId");
    assertValidSessionKey(jobData.key);
    const derivedSessionId = buildSessionId(jobData.userId, jobData.key);
    if (jobData.sessionId !== derivedSessionId) {
      throw new Error("Session id mismatch for user/key");
    }
    return jobData;
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

function mergeBufferedMessages(messages: SessionEvent[]): SessionEvent {
  const last = messages[messages.length - 1];
  const combined = messages
    .map((message) => formatBufferedMessage(message))
    .filter((line) => line.length > 0)
    .join("\n");
  return {
    ...last,
    content: combined,
    elements: combined ? [{ type: "text", text: combined }] : [],
  };
}

function formatBufferedMessage(message: SessionEvent): string {
  const timestamp = new Date(message.timestamp).toISOString();
  const content = message.content.trim() ? message.content.trim() : "<empty>";
  return `- [${timestamp}] ${content}`;
}
