import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import pino from "pino";

import type { ResponseQueue, SessionJob } from "../../queue";
import { BullmqSessionQueue } from "../../queue";
import { SessionManager, buildSessionId } from "../../session";
import type { SessionActivityTracker } from "../../session";
import type { OpencodeRunner, OpencodeRunResult } from "../runner";
import { SessionWorker } from "../worker";

class MemoryActivityIndex implements SessionActivityTracker {
  async recordActivity(): Promise<void> {}
}

class FakeRunner implements OpencodeRunner {
  async run(): Promise<OpencodeRunResult> {
    return { output: "Test response" };
  }
}

class MemoryResponseQueue implements ResponseQueue {
  private resolver?: (job: SessionJob["data"]) => void;
  private promise: Promise<SessionJob["data"]>;

  constructor() {
    this.promise = new Promise((resolve) => {
      this.resolver = resolve;
    });
  }

  async enqueue(jobData: SessionJob["data"]): Promise<SessionJob> {
    this.resolver?.(jobData);
    return { id: "response-job", data: jobData };
  }

  async close(): Promise<void> {}

  async waitForJob(timeoutMs: number): Promise<SessionJob["data"]> {
    return withTimeout(this.promise, timeoutMs);
  }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error("Timed out waiting for response"));
    }, timeoutMs);
    promise
      .then((value) => {
        clearTimeout(timer);
        resolve(value);
      })
      .catch((err) => {
        clearTimeout(timer);
        reject(err);
      });
  });
}

const redisEnabled = process.env.REDIS_INTEGRATION === "1";
const integrationTest = redisEnabled ? test : test.skip;

describe("session worker integration", () => {
  integrationTest("processes job and writes history", async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), "session-worker-"));
    const logger = pino({ level: "silent" });
    const redisUrl = process.env.REDIS_URL ?? "redis://localhost:6379";
    const queueName = `session-test-${Date.now()}`;
    const responseQueue = new MemoryResponseQueue();
    const sessionManager = new SessionManager({
      dataDir: tempDir,
      logger,
      activityIndex: new MemoryActivityIndex(),
    });
    const worker = new SessionWorker({
      id: "session-test",
      queueName,
      redisUrl,
      sessionManager,
      runner: new FakeRunner(),
      logger,
      responseQueue,
    });
    const sessionQueue = new BullmqSessionQueue({
      redisUrl,
      queueName,
    });

    try {
      await worker.start();
      const groupId = "group-1";
      const userId = "user-1";
      const key = 0;
      const sessionId = buildSessionId(userId, key);
      await sessionQueue.enqueue({
        groupId,
        sessionId,
        userId,
        key,
        payload: {
          input: "Hello there",
          channelId: "channel-1",
          channelType: "group",
        },
      });

      const response = await responseQueue.waitForJob(5000);
      expect(response.content).toBe("Test response");

      const session = await sessionManager.getSession(groupId, sessionId);
      expect(session).not.toBeNull();
      const history = await sessionManager.readHistory(session!, {
        maxEntries: 20,
      });
      const assistant = history.filter((entry) => entry.role === "assistant");
      expect(assistant.length).toBeGreaterThan(0);
      expect(assistant[assistant.length - 1].content).toBe("Test response");
    } finally {
      await worker.stop();
      await sessionQueue.close();
      await responseQueue.close();
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
