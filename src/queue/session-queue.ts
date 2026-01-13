import { Queue, type JobsOptions } from "bullmq";
import IORedis from "ioredis";
import type { SessionEvent } from "../types/platform";

export interface SessionJobData {
  groupId: string;
  sessionId: string;
  userId: string;
  key: number;
  session: SessionEvent;
}

export interface SessionJob {
  id: string;
  data: SessionJobData;
}

export interface BullmqSessionQueueOptions {
  redisUrl: string;
  queueName: string;
  defaultJobOptions?: JobsOptions;
}

export class BullmqSessionQueue {
  private queue: Queue<SessionJobData>;
  private connection: IORedis;

  constructor(options: BullmqSessionQueueOptions) {
    this.connection = new IORedis(options.redisUrl, {
      maxRetriesPerRequest: null,
    });

    this.queue = new Queue(options.queueName, {
      connection: this.connection,
      defaultJobOptions: {
        attempts: 3,
        backoff: {
          type: "exponential",
          delay: 1000,
        },
        removeOnComplete: true,
        removeOnFail: 100, // Keep last 100 failed jobs
        ...options.defaultJobOptions,
      },
    });
  }

  async enqueue(
    jobData: SessionJobData,
    opts?: JobsOptions,
  ): Promise<SessionJob> {
    const job = await this.queue.add("session-job", jobData, opts);

    return {
      id: job.id!,
      data: jobData,
    };
  }

  async close(): Promise<void> {
    await this.queue.close();
    await this.connection.quit();
  }
}
