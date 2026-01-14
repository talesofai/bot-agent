import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import pino from "pino";

import type { ResponseJob, ResponseJobData, ResponseQueue } from "../../queue";
import { BullmqSessionQueue } from "../../queue";
import { SessionBufferStore } from "../../session/buffer";
import { HistoryStore } from "../../session/history";
import { SessionRepository } from "../../session/repository";
import { buildSessionId } from "../../session/utils";
import type { OpencodeRunner, OpencodeRunResult } from "../runner";
import { SessionWorker } from "../worker";

class FakeRunner implements OpencodeRunner {
  async run(): Promise<OpencodeRunResult> {
    return { output: "Test response" };
  }
}

class MemoryResponseQueue implements ResponseQueue {
  private resolver?: (job: ResponseJobData) => void;
  private promise: Promise<ResponseJobData>;

  constructor() {
    this.promise = new Promise((resolve) => {
      this.resolver = resolve;
    });
  }

  async enqueue(jobData: ResponseJobData): Promise<ResponseJob> {
    this.resolver?.(jobData);
    return { id: "response-job", data: jobData };
  }

  async close(): Promise<void> {}

  async waitForJob(timeoutMs: number): Promise<ResponseJobData> {
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
    const worker = new SessionWorker({
      id: "session-test",
      dataDir: tempDir,
      redis: {
        url: redisUrl,
      },
      queue: {
        name: queueName,
      },
      runner: new FakeRunner(),
      logger,
      responseQueue,
    });
    const sessionQueue = new BullmqSessionQueue({
      redisUrl,
      queueName,
    });
    const bufferStore = new SessionBufferStore({ redisUrl });

    try {
      await worker.start();
      const groupId = "group-1";
      const userId = "user-1";
      const key = 0;
      const sessionId = buildSessionId(userId, key);
      const session = {
        type: "message",
        platform: "test",
        selfId: "bot-1",
        userId,
        guildId: groupId,
        channelId: "channel-1",
        messageId: "msg-1",
        content: "Hello there",
        elements: [{ type: "text", text: "Hello there" }],
        timestamp: Date.now(),
        extras: {},
      } as const;
      await bufferStore.append(sessionId, session);
      await sessionQueue.enqueue({
        groupId,
        sessionId,
        userId,
        key,
      });

      const response = await responseQueue.waitForJob(5000);
      expect(response.content).toBe("Test response");

      const sessionRepository = new SessionRepository({
        dataDir: tempDir,
        logger,
      });
      const historyStore = new HistoryStore(logger);
      const session = await sessionRepository.loadSession(groupId, sessionId);
      expect(session).not.toBeNull();
      const history = await historyStore.readHistory(session!.historyPath, {
        maxEntries: 20,
      });
      const assistant = history.filter((entry) => entry.role === "assistant");
      expect(assistant.length).toBeGreaterThan(0);
      expect(assistant[assistant.length - 1].content).toBe("Test response");
    } finally {
      await worker.stop();
      await sessionQueue.close();
      await bufferStore.close();
      await responseQueue.close();
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  integrationTest("normalizes empty input to a single space", async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), "session-worker-"));
    const logger = pino({ level: "silent" });
    const redisUrl = process.env.REDIS_URL ?? "redis://localhost:6379";
    const queueName = `session-empty-test-${Date.now()}`;
    const responseQueue = new MemoryResponseQueue();
    const worker = new SessionWorker({
      id: "session-empty-test",
      dataDir: tempDir,
      redis: {
        url: redisUrl,
      },
      queue: {
        name: queueName,
      },
      runner: new FakeRunner(),
      logger,
      responseQueue,
    });
    const sessionQueue = new BullmqSessionQueue({
      redisUrl,
      queueName,
    });
    const bufferStore = new SessionBufferStore({ redisUrl });

    try {
      await worker.start();
      const groupId = "group-1";
      const userId = "user-1";
      const key = 0;
      const sessionId = buildSessionId(userId, key);
      const session = {
        type: "message",
        platform: "test",
        selfId: "bot-1",
        userId,
        guildId: groupId,
        channelId: "channel-1",
        messageId: "msg-1",
        content: "   ",
        elements: [],
        timestamp: Date.now(),
        extras: {},
      } as const;
      await bufferStore.append(sessionId, session);
      await sessionQueue.enqueue({
        groupId,
        sessionId,
        userId,
        key,
      });

      const response = await responseQueue.waitForJob(5000);
      expect(response.session.content).toContain("<empty>");

      const sessionRepository = new SessionRepository({
        dataDir: tempDir,
        logger,
      });
      const historyStore = new HistoryStore(logger);
      const session = await sessionRepository.loadSession(groupId, sessionId);
      expect(session).not.toBeNull();
      const history = await historyStore.readHistory(session!.historyPath, {
        maxEntries: 20,
      });
      const userEntries = history.filter((entry) => entry.role === "user");
      expect(userEntries[userEntries.length - 1]?.content).toBe(" ");
    } finally {
      await worker.stop();
      await sessionQueue.close();
      await bufferStore.close();
      await responseQueue.close();
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
