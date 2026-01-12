import { Queue, type JobsOptions } from "bullmq";
import IORedis from "ioredis";
import type { ChannelType } from "../types/platform";

export interface SessionJobPayload {
  input: string;
  channelId: string;
  messageId?: string;
  channelType?: ChannelType;
  platform?: string;
}

export interface SessionJobData {
  groupId: string;
  sessionId: string;
  userId: string;
  key: number;
  payload: SessionJobPayload;
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
    const data: SessionJobData = { ...jobData };

    const job = await this.queue.add("session-job", data, opts);

    return {
      id: job.id!,
      data,
    };
  }

  async close(): Promise<void> {
    await this.queue.close();
    await this.connection.quit();
  }
}
