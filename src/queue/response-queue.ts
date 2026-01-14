import { Queue, type JobsOptions } from "bullmq";
import IORedis from "ioredis";
import type { SessionEvent } from "../types/platform";

export interface ResponseJobData {
  content: string;
  session: SessionEvent;
}

export interface ResponseJob {
  id: string;
  data: ResponseJobData;
}

export interface ResponseQueue {
  enqueue(jobData: ResponseJobData, opts?: JobsOptions): Promise<ResponseJob>;
  close(): Promise<void>;
}

export interface BullmqResponseQueueOptions {
  redisUrl: string;
  queueName: string;
  defaultJobOptions?: JobsOptions;
}

export class BullmqResponseQueue implements ResponseQueue {
  private queue: Queue<ResponseJobData>;
  private connection: IORedis;

  constructor(options: BullmqResponseQueueOptions) {
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
        removeOnFail: 100,
        ...options.defaultJobOptions,
      },
    });
  }

  async enqueue(
    jobData: ResponseJobData,
    opts?: JobsOptions,
  ): Promise<ResponseJob> {
    const job = await this.queue.add("response-job", jobData, opts);
    return { id: String(job.id ?? `job-${Date.now()}`), data: jobData };
  }

  async close(): Promise<void> {
    await this.queue.close();
    await this.connection.quit();
  }
}
