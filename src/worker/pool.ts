import type { Logger } from "pino";

import type { PlatformAdapter } from "../types/platform";
import type { OpencodeRunner } from "./runner";
import { SessionWorker } from "./worker";
import type { OpencodeClient } from "../opencode/server-client";

export interface SessionWorkerPoolOptions {
  size: number;
  queueName: string;
  redisUrl: string;
  databaseUrl: string;
  dataDir: string;
  adapter: PlatformAdapter;
  opencodeClient: OpencodeClient;
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
      databaseUrl: options.databaseUrl,
      opencodeClient: options.opencodeClient,
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
