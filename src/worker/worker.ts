import { Worker, type Job, DelayedError } from "bullmq";
import IORedis from "ioredis";
import type { Logger } from "pino";

import type { ResponseQueue, SessionJob, SessionJobData } from "../queue";
import type { SessionManager } from "../session";
import { OpencodeLauncher } from "../opencode/launcher";
import { buildOpencodePrompt } from "../opencode/prompt";
import { buildSystemPrompt } from "../opencode/system-prompt";
import type { OpencodeRunner } from "./runner";
import type { HistoryEntry, SessionInfo } from "../types/session";

export interface SessionWorkerOptions {
  id: string;
  queueName: string;
  redisUrl: string;
  sessionManager: SessionManager;
  launcher?: OpencodeLauncher;
  runner: OpencodeRunner;
  logger: Logger;
  concurrency?: number;
  prefix?: string;
  requeueDelayMs?: number;
  historyMaxEntries?: number;
  historyMaxBytes?: number;
  sessionLockTtlSeconds?: number;
  stalledIntervalMs?: number;
  maxStalledCount?: number;
  responseQueue?: ResponseQueue;
}

export class SessionWorker {
  private worker: Worker<SessionJobData>;
  private logger: Logger;
  private sessionManager: SessionManager;
  private launcher: OpencodeLauncher;
  private runner: OpencodeRunner;
  private responseQueue?: ResponseQueue;
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
    this.historyMaxEntries = options.historyMaxEntries;
    this.historyMaxBytes = options.historyMaxBytes;
    this.sessionLockTtlSeconds = options.sessionLockTtlSeconds ?? 600;
    this.requeueDelayMs = options.requeueDelayMs ?? 2000;
    this.stalledIntervalMs = options.stalledIntervalMs ?? 30_000;
    this.maxStalledCount = options.maxStalledCount ?? 1;

    this.workerConnection = new IORedis(options.redisUrl, {
      maxRetriesPerRequest: null,
    });
    this.lockConnection = new IORedis(options.redisUrl, {
      maxRetriesPerRequest: null,
    });

    this.worker = new Worker<SessionJobData>(
      options.queueName,
      async (job: Job<SessionJobData>) => {
        return this.processJob(job);
      },
      {
        connection: this.workerConnection,
        concurrency: options.concurrency ?? 1,
        prefix: options.prefix,
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
  }

  private async processJob(job: Job<SessionJobData>): Promise<void> {
    const { sessionId, groupId, userId, key, payload } = job.data;
    const lockKey = `session:lock:${sessionId}`;

    // 1. Acquire Lock
    // ioredis v5: set(key, value, "EX", seconds, "NX")
    const acquired = await this.lockConnection.set(
      lockKey,
      "locked",
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

      // 3. Update Status
      await this.sessionManager.updateStatus(sessionInfo, "running");
      statusUpdated = true;

      // 4. Prepare Context
      const history = await this.sessionManager.readHistory(sessionInfo, {
        maxEntries: this.historyMaxEntries,
        maxBytes: this.historyMaxBytes,
      });
      const agentPrompt = await this.sessionManager.getAgentPrompt(groupId);
      const systemPrompt = buildSystemPrompt(agentPrompt);
      const prompt = buildOpencodePrompt({
        systemPrompt,
        history,
        input: payload.input,
      });
      const launchSpec = this.launcher.buildLaunchSpec(sessionInfo, prompt);

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
        payload,
        result.historyEntries,
        result.output,
      );
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
      await this.lockConnection.del(lockKey);
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
    payload: SessionJobData["payload"],
    historyEntries?: HistoryEntry[],
    output?: string,
  ): Promise<void> {
    const entries: HistoryEntry[] = [];

    if (
      payload?.input &&
      !historyEntries?.some((entry) => entry.role === "user")
    ) {
      entries.push({
        role: "user",
        content: payload.input,
        createdAt: new Date().toISOString(),
      });
    }

    const hasAssistantEntry = historyEntries?.some(
      (entry) => entry.role === "assistant",
    );

    if (historyEntries && historyEntries.length > 0) {
      entries.push(...historyEntries);
    }

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
      platform: jobData.payload.platform,
      channelId: jobData.payload.channelId,
      channelType: jobData.payload.channelType ?? "group",
      messageId: jobData.payload.messageId,
      content: output,
      groupId: jobData.groupId,
      userId: jobData.userId,
      sessionId: jobData.sessionId,
    });
  }
}
