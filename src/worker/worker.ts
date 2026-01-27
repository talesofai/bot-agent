import { Worker, type Job } from "bullmq";
import IORedis from "ioredis";
import type { Logger } from "pino";

import type { SessionJobData } from "../queue";
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
    })();

    return this.startPromise;
  }

  async stop(): Promise<void> {
    await this.worker.close();
    await this.workerConnection.quit();
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
}
