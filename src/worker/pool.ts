import type { Logger } from "pino";

import type { OpencodeRunner } from "./runner";
import { SessionWorker } from "./worker";

export interface SessionWorkerPoolOptions {
  size: number;
  queueName: string;
  redisUrl: string;
  dataDir: string;
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
      dataDir: options.dataDir,
      redis: {
        url: options.redisUrl,
      },
      queue: {
        name: options.queueName,
        concurrency: options.size,
        prefix: options.prefix,
        stalledIntervalMs: options.stalledIntervalMs,
        maxStalledCount: options.maxStalledCount,
      },
      runner: options.runner,
      logger: this.logger,
      limits: {
        historyEntries: options.historyMaxEntries,
        historyBytes: options.historyMaxBytes,
        lockTtlSeconds: options.sessionLockTtlSeconds,
        requeueDelayMs: options.requeueDelayMs,
      },
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
