import { Worker, type Job } from "bullmq";
import IORedis from "ioredis";
import type { Logger } from "pino";

import type { ResponseJobData } from "../queue";
import type { PlatformAdapter } from "../types/platform";

export interface ResponseWorkerOptions {
  id: string;
  queueName: string;
  redisUrl: string;
  adapter: PlatformAdapter;
  logger: Logger;
  concurrency?: number;
  prefix?: string;
}

export class ResponseWorker {
  private worker: Worker<ResponseJobData>;
  private logger: Logger;
  private adapter: PlatformAdapter;
  private connection: IORedis;

  constructor(options: ResponseWorkerOptions) {
    this.logger = options.logger.child({
      component: "response-worker",
      workerId: options.id,
    });
    this.adapter = options.adapter;
    this.connection = new IORedis(options.redisUrl, {
      maxRetriesPerRequest: null,
    });

    this.worker = new Worker<ResponseJobData>(
      options.queueName,
      async (job: Job<ResponseJobData>) => {
        await this.processJob(job);
      },
      {
        connection: this.connection,
        concurrency: options.concurrency ?? 1,
        prefix: options.prefix,
        autorun: false,
      },
    );

    this.worker.on("error", (err) => {
      this.logger.error({ err }, "Response worker error");
    });
    this.worker.on("failed", (job, err) => {
      this.logger.error({ err, jobId: job?.id }, "Response job failed");
    });
  }

  start(): void {
    this.worker.run().catch((err) => {
      this.logger.error({ err }, "Response worker run loop failed");
    });
  }

  async stop(): Promise<void> {
    await this.worker.close();
    await this.connection.quit();
  }

  private async processJob(job: Job<ResponseJobData>): Promise<void> {
    const { content, session } = job.data;
    await this.adapter.sendMessage(session, content);
    this.logger.info(
      {
        jobId: job.id,
        channelId: session.channelId,
        platform: session.platform,
        messageId: session.messageId,
      },
      "Response sent",
    );
  }
}
