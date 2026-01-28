import { randomBytes } from "node:crypto";
import { Worker, type Job } from "bullmq";
import IORedis from "ioredis";
import type { Logger } from "pino";

import { BullmqSessionQueue, type SessionJobData } from "../queue";
import { GroupFileRepository } from "../store/repository";
import { SessionRepository } from "../session/repository";
import type { HistoryStore } from "../session/history";
import { NoopHistoryStore } from "../session/history";
import type { OpencodeRunner } from "./runner";
import type { OpencodeClient } from "../opencode/server-client";
import type { PlatformAdapter } from "../types/platform";
import { SessionActivityStore } from "../session/activity-store";
import { assertValidSessionKey } from "../session/utils";
import { assertSafePathSegment } from "../utils/path";
import { SessionBufferStore } from "../session/buffer";
import { SessionProcessor } from "../session/processor";

export interface SessionWorkerOptions {
  id: string;
  dataDir: string;
  adapter: PlatformAdapter;
  historyStore?: HistoryStore;
  opencodeClient: OpencodeClient;
  onFatalError?: (err: unknown) => void | Promise<void>;
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
  runner: OpencodeRunner;
  logger: Logger;
}

export class SessionWorker {
  private worker: Worker<SessionJobData>;
  private logger: Logger;
  private workerConnection: IORedis;
  private processor: SessionProcessor;
  private sessionRepository: SessionRepository;
  private bufferStore: SessionBufferStore;
  private recoveryQueue: BullmqSessionQueue;
  private recoveryTimer: ReturnType<typeof setInterval> | null = null;
  private recoveryRunning = false;
  private recoveryCursor = "0";
  private stalledIntervalMs: number;
  private maxStalledCount: number;
  private startPromise: Promise<void> | null = null;
  private runPromise: Promise<void> | null = null;
  private fatalErrorHandled = false;
  private onFatalError?: (err: unknown) => void | Promise<void>;

  constructor(options: SessionWorkerOptions) {
    this.logger = options.logger.child({
      component: "session-worker",
      workerId: options.id,
    });
    this.onFatalError = options.onFatalError;
    const groupRepository = new GroupFileRepository({
      dataDir: options.dataDir,
      logger: this.logger,
    });
    const sessionRepository = new SessionRepository({
      dataDir: options.dataDir,
      logger: this.logger,
    });
    this.sessionRepository = sessionRepository;
    const historyStore = options.historyStore ?? new NoopHistoryStore();
    this.stalledIntervalMs = options.queue.stalledIntervalMs ?? 30_000;
    this.maxStalledCount = options.queue.maxStalledCount ?? 1;

    const activityIndex = new SessionActivityStore({
      redisUrl: options.redis.url,
      logger: this.logger,
    });

    this.workerConnection = new IORedis(options.redis.url, {
      maxRetriesPerRequest: null,
    });
    const bufferStore = new SessionBufferStore({ redisUrl: options.redis.url });
    this.bufferStore = bufferStore;
    this.recoveryQueue = new BullmqSessionQueue({
      redisUrl: options.redis.url,
      queueName: options.queue.name,
      prefix: options.queue.prefix,
    });
    this.processor = new SessionProcessor({
      logger: this.logger,
      adapter: options.adapter,
      groupRepository,
      sessionRepository,
      historyStore,
      opencodeClient: options.opencodeClient,
      runner: options.runner,
      activityIndex,
      bufferStore,
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
      this.logger.error(
        { err, jobId: job?.id, traceId: job?.data?.traceId },
        "Job failed",
      );
    });
  }

  async start(): Promise<void> {
    if (this.startPromise) {
      return this.startPromise;
    }

    this.startPromise = (async () => {
      if (!this.runPromise) {
        this.runPromise = this.worker.run();
        this.runPromise.catch((err) => {
          this.logger.error({ err }, "Worker run loop failed");
          this.handleFatalError(err);
        });
      }

      await Promise.race([
        this.worker.waitUntilReady().then(() => undefined),
        this.runPromise.then(() => {
          throw new Error("Worker exited before it was ready");
        }),
      ]);

      this.startRecoveryLoop();
    })();

    return this.startPromise;
  }

  async stop(): Promise<void> {
    this.stopRecoveryLoop();
    await this.worker.close();
    await this.workerConnection.quit();
    await this.recoveryQueue.close();
    await this.processor.close();
  }

  private handleFatalError(err: unknown): void {
    if (this.fatalErrorHandled) {
      return;
    }
    this.fatalErrorHandled = true;

    if (this.onFatalError) {
      void this.onFatalError(err);
      return;
    }

    queueMicrotask(() => {
      throw err;
    });
  }

  private async processJob(job: Job<SessionJobData>): Promise<void> {
    const jobData = this.validateJobData(job.data);
    await this.processor.process(job, jobData);
  }

  private validateJobData(jobData: SessionJobData): SessionJobData {
    assertSafePathSegment(jobData.botId, "botId");
    assertSafePathSegment(jobData.groupId, "groupId");
    assertSafePathSegment(jobData.userId, "userId");
    assertSafePathSegment(jobData.sessionId, "sessionId");
    assertSafePathSegment(jobData.gateToken, "gateToken");
    assertValidSessionKey(jobData.key);
    return jobData;
  }

  private startRecoveryLoop(): void {
    if (this.recoveryTimer) {
      return;
    }
    const intervalMs = 10_000;
    this.recoveryTimer = setInterval(() => {
      void this.recoverOrphanedBuffersOnce();
    }, intervalMs);
    void this.recoverOrphanedBuffersOnce();
  }

  private stopRecoveryLoop(): void {
    if (!this.recoveryTimer) {
      return;
    }
    clearInterval(this.recoveryTimer);
    this.recoveryTimer = null;
  }

  private async recoverOrphanedBuffersOnce(): Promise<void> {
    if (this.recoveryRunning) {
      return;
    }
    this.recoveryRunning = true;
    try {
      const [nextCursor, keys] = await this.workerConnection.scan(
        this.recoveryCursor,
        "MATCH",
        "session:buffer:*",
        "COUNT",
        "100",
      );
      this.recoveryCursor = nextCursor;

      let recovered = 0;
      for (const redisKey of keys) {
        if (recovered >= 20) {
          break;
        }
        const ok = await this.tryRecoverBufferKey(redisKey);
        if (ok) {
          recovered += 1;
        }
      }
    } catch (err) {
      this.logger.warn({ err }, "Session buffer recovery scan failed");
    } finally {
      this.recoveryRunning = false;
    }
  }

  private parseBufferKey(redisKey: string): {
    botId: string;
    groupId: string;
    sessionId: string;
  } | null {
    const parts = redisKey.split(":");
    if (parts.length !== 5) {
      return null;
    }
    if (parts[0] !== "session" || parts[1] !== "buffer") {
      return null;
    }
    const botId = parts[2]?.trim() ?? "";
    const groupId = parts[3]?.trim() ?? "";
    const sessionId = parts[4]?.trim() ?? "";
    if (!botId || !groupId || !sessionId) {
      return null;
    }
    try {
      assertSafePathSegment(botId, "botId");
      assertSafePathSegment(groupId, "groupId");
      assertSafePathSegment(sessionId, "sessionId");
    } catch {
      return null;
    }
    return { botId, groupId, sessionId };
  }

  private async tryRecoverBufferKey(redisKey: string): Promise<boolean> {
    const parsedKey = this.parseBufferKey(redisKey);
    if (!parsedKey) {
      return false;
    }

    const pending = await this.workerConnection.llen(redisKey);
    if (pending <= 0) {
      return false;
    }

    const first = await this.workerConnection.lindex(redisKey, 0);
    if (!first) {
      return false;
    }
    let userId = "";
    let traceId: string | undefined;
    try {
      const parsed = JSON.parse(first) as unknown;
      if (parsed && typeof parsed === "object") {
        const record = parsed as Record<string, unknown>;
        const rawUserId = record.userId;
        if (typeof rawUserId === "string") {
          userId = rawUserId.trim();
        }
        const extras = record.extras;
        if (extras && typeof extras === "object") {
          const rawTraceId = (extras as Record<string, unknown>).traceId;
          if (typeof rawTraceId === "string" && rawTraceId.trim()) {
            traceId = rawTraceId.trim();
          }
        }
      }
    } catch {
      return false;
    }
    if (!userId) {
      return false;
    }

    const sessionInfo = await this.sessionRepository.loadSession(
      parsedKey.botId,
      parsedKey.groupId,
      userId,
      parsedKey.sessionId,
    );
    if (!sessionInfo) {
      this.logger.warn(
        { redisKey, botId: parsedKey.botId, groupId: parsedKey.groupId },
        "Orphaned session buffer has no session meta; dropping",
      );
      await this.workerConnection.del(redisKey);
      return false;
    }

    const gateToken = randomBytes(12).toString("hex");
    const claimed = await this.bufferStore.claimGate(
      {
        botId: parsedKey.botId,
        groupId: parsedKey.groupId,
        sessionId: parsedKey.sessionId,
      },
      gateToken,
    );
    if (!claimed) {
      return false;
    }

    try {
      await this.recoveryQueue.enqueue({
        botId: parsedKey.botId,
        groupId: parsedKey.groupId,
        sessionId: parsedKey.sessionId,
        userId: sessionInfo.meta.ownerId,
        key: sessionInfo.meta.key,
        gateToken,
        traceId,
        enqueuedAt: Date.now(),
      });
      this.logger.warn(
        {
          botId: parsedKey.botId,
          groupId: parsedKey.groupId,
          sessionId: parsedKey.sessionId,
          userId: sessionInfo.meta.ownerId,
          pending,
        },
        "Recovered orphaned session buffer by enqueuing job",
      );
      return true;
    } catch (err) {
      await this.bufferStore.releaseGate(
        {
          botId: parsedKey.botId,
          groupId: parsedKey.groupId,
          sessionId: parsedKey.sessionId,
        },
        gateToken,
      );
      this.logger.warn(
        { err, botId: parsedKey.botId, groupId: parsedKey.groupId },
        "Failed to enqueue recovery job",
      );
      return false;
    }
  }
}
