import type { Logger } from "pino";

import type { PlatformAdapter } from "../types/platform";
import type { OpencodeRunner } from "./runner";
import { SessionWorker } from "./worker";

export interface SessionWorkerPoolOptions {
  size: number;
  queueName: string;
  redisUrl: string;
  dataDir: string;
  adapter: PlatformAdapter;
  runner: OpencodeRunner;
  logger: Logger;
  prefix?: string;
  historyMaxEntries?: number;
  historyMaxBytes?: number;
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
      adapter: options.adapter,
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
