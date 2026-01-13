import { Worker, type Job, DelayedError } from "bullmq";
import { randomUUID } from "node:crypto";
import IORedis from "ioredis";
import type { Logger } from "pino";

import type { ResponseQueue, SessionJob, SessionJobData } from "../queue";
import type { SessionManager } from "../session";
import { OpencodeLauncher } from "../opencode/launcher";
import { buildOpencodePrompt } from "../opencode/prompt";
import { buildSystemPrompt } from "../opencode/system-prompt";
import type { OpencodeRunner } from "./runner";
import type { HistoryEntry, SessionInfo } from "../types/session";
import { SessionActivityStore } from "../session/activity-store";

export interface SessionWorkerOptions {
  id: string;
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
  sessionManager: SessionManager;
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
  private sessionManager: SessionManager;
  private launcher: OpencodeLauncher;
  private runner: OpencodeRunner;
  private responseQueue?: ResponseQueue;
  private activityIndex: SessionActivityStore;
  private workerConnection: IORedis;
  private lockConnection: IORedis;
  private historyMaxEntries?: number;
  private historyMaxBytes?: number;
  private sessionLockTtlSeconds: number;
  private requeueDelayMs: number;
  private stalledIntervalMs: number;
  private maxStalledCount: number;

  constructor(options: SessionWorkerOptions) {
    this.logger = options.logger.child({
      component: "session-worker",
      workerId: options.id,
    });
    this.sessionManager = options.sessionManager;
    this.launcher = options.launcher ?? new OpencodeLauncher();
    this.runner = options.runner;
    this.responseQueue = options.responseQueue;
    this.historyMaxEntries = options.limits?.historyEntries;
    this.historyMaxBytes = options.limits?.historyBytes;
    this.sessionLockTtlSeconds = options.limits?.lockTtlSeconds ?? 600;
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
  }

  private async processJob(job: Job<SessionJobData>): Promise<void> {
    const { sessionId, groupId, userId, key, session } = job.data;
    const lockKey = `session:lock:${groupId}:${sessionId}`;

    // 1. Acquire Lock
    const lockValue = `${sessionId}:${randomUUID()}`;
    // ioredis v5: set(key, value, "EX", seconds, "NX")
    const acquired = await this.lockConnection.set(
      lockKey,
      lockValue,
      "EX",
      this.sessionLockTtlSeconds,
      "NX",
    );
    if (!acquired) {
      this.logger.debug({ sessionId }, "Session busy, delaying job");
      if (!job.token) {
        throw new Error("Missing BullMQ job token for requeue");
      }
      await job.moveToDelayed(Date.now() + this.requeueDelayMs, job.token);
      throw new DelayedError();
    }

    let statusUpdated = false;
    let sessionInfo: SessionInfo | null = null;

    try {
      // 2. Ensure Session Exists
      sessionInfo = await this.ensureSession(groupId, userId, key, sessionId);
      await this.recordActivity(sessionInfo);

      // 3. Update Status
      await this.sessionManager.updateStatus(sessionInfo, "running");
      statusUpdated = true;
      await this.recordActivity(sessionInfo);

      // 4. Prepare Context
      const history = await this.sessionManager.readHistory(sessionInfo, {
        maxEntries: this.historyMaxEntries,
        maxBytes: this.historyMaxBytes,
      });
      const groupConfig = await this.sessionManager.getGroupConfig(groupId);
      const agentPrompt = await this.sessionManager.getAgentPrompt(groupId);
      const systemPrompt = buildSystemPrompt(agentPrompt);
      const prompt = buildOpencodePrompt({
        systemPrompt,
        history,
        input: session.content,
      });
      const launchSpec = this.launcher.buildLaunchSpec(
        sessionInfo,
        prompt,
        groupConfig.model,
      );

      // 5. Run
      const result = await this.runner.run({
        job: this.mapJob(job),
        session: sessionInfo,
        history,
        launchSpec,
      });

      // 6. Append History
      await this.appendHistoryFromJob(
        sessionInfo,
        session,
        result.historyEntries,
        result.output,
      );
      await this.recordActivity(sessionInfo);
      await this.enqueueResponse(job.data, result.output);
    } catch (err) {
      this.logger.error({ err, sessionId }, "Error processing session job");
      throw err;
    } finally {
      if (statusUpdated && sessionInfo) {
        try {
          await this.sessionManager.updateStatus(sessionInfo, "idle");
        } catch (err) {
          this.logger.warn({ err }, "Failed to update session status to idle");
        }
      }
      // 8. Release Lock
      try {
        await this.releaseLock(lockKey, lockValue);
      } catch (err) {
        this.logger.warn({ err }, "Failed to release session lock");
      }
    }
  }

  private async ensureSession(
    groupId: string,
    userId: string,
    key: number,
    expectedSessionId: string,
  ): Promise<SessionInfo> {
    const existing = await this.sessionManager.getSession(
      groupId,
      expectedSessionId,
    );
    if (existing) {
      return existing;
    }
    return this.sessionManager.createSession(groupId, userId, { key });
  }

  private async appendHistoryFromJob(
    sessionInfo: SessionInfo,
    session: SessionJobData["session"],
    historyEntries?: HistoryEntry[],
    output?: string,
  ): Promise<void> {
    const entries: HistoryEntry[] = [];

    if (session.content) {
      entries.push({
        role: "user",
        content: session.content,
        createdAt: new Date().toISOString(),
      });
    }

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
        createdAt: new Date().toISOString(),
      });
    }

    for (const entry of entries) {
      await this.sessionManager.appendHistory(sessionInfo, entry);
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
    jobData: SessionJobData,
    output?: string,
  ): Promise<void> {
    if (!output || !this.responseQueue) {
      return;
    }
    await this.responseQueue.enqueue({
      content: output,
      session: jobData.session,
    });
  }

  private async releaseLock(lockKey: string, lockValue: string): Promise<void> {
    const script =
      "if redis.call('get', KEYS[1]) == ARGV[1] then " +
      "return redis.call('del', KEYS[1]) " +
      "else return 0 end";
    await this.lockConnection.eval(script, 1, lockKey, lockValue);
  }
}
