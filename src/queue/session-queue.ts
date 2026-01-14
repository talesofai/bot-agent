import { Queue, type JobsOptions } from "bullmq";
import IORedis from "ioredis";
import { assertSafePathSegment } from "../utils/path";
import { assertValidSessionKey, buildSessionId } from "../session/utils";

export interface SessionJobData {
  groupId: string;
  sessionId: string;
  userId: string;
  key: number;
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
    assertSafePathSegment(jobData.groupId, "groupId");
    assertSafePathSegment(jobData.userId, "userId");
    assertValidSessionKey(jobData.key);
    const derivedSessionId = buildSessionId(jobData.userId, jobData.key);
    assertSafePathSegment(derivedSessionId, "sessionId");
    if (jobData.sessionId !== derivedSessionId) {
      throw new Error("Session id mismatch for user/key");
    }
    const job = await this.queue.add("session-job", jobData, opts);

    return {
      id: String(job.id ?? `job-${Date.now()}`),
      data: jobData,
    };
  }

  async close(): Promise<void> {
    await this.queue.close();
    await this.connection.quit();
  }
}
