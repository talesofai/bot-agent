import { Queue, type JobsOptions } from "bullmq";
import IORedis from "ioredis";
import type { ChannelType } from "../types/platform";

export interface ResponseJobData {
  platform?: string;
  channelId: string;
  channelType: ChannelType;
  messageId?: string;
  content: string;
  groupId?: string;
  userId?: string;
  sessionId?: string;
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
    return { id: job.id!, data: jobData };
  }

  async close(): Promise<void> {
    await this.queue.close();
    await this.connection.quit();
  }
}
