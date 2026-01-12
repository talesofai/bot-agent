import type { Logger } from "pino";

import type { SessionManager } from "../session";
import type { OpencodeRunner } from "./runner";
import { SessionWorker } from "./worker";

export interface SessionWorkerPoolOptions {
  size: number;
  queueName: string;
  redisUrl: string;
  sessionManager: SessionManager;
  runner: OpencodeRunner;
  logger: Logger;
  prefix?: string;
  requeueDelayMs?: number;
  historyMaxEntries?: number;
  historyMaxBytes?: number;
  sessionLockTtlSeconds?: number;
  stalledIntervalMs?: number;
  maxStalledCount?: number;
}

export class SessionWorkerPool {
  private worker: SessionWorker;
  private logger: Logger;

  constructor(options: SessionWorkerPoolOptions) {
    this.logger = options.logger.child({ component: "session-worker-pool" });
    this.worker = new SessionWorker({
      id: "pool",
      queueName: options.queueName,
      redisUrl: options.redisUrl,
      sessionManager: options.sessionManager,
      runner: options.runner,
      logger: this.logger,
      prefix: options.prefix,
      concurrency: options.size,
      requeueDelayMs: options.requeueDelayMs,
      historyMaxEntries: options.historyMaxEntries,
      historyMaxBytes: options.historyMaxBytes,
      sessionLockTtlSeconds: options.sessionLockTtlSeconds,
      stalledIntervalMs: options.stalledIntervalMs,
      maxStalledCount: options.maxStalledCount,
    });
  }

  start(): void {
    this.worker.start();
    this.logger.info("Worker pool started");
  }

  async stop(): Promise<void> {
    await this.worker.stop();
    this.logger.info("Worker pool stopped");
  }
}
