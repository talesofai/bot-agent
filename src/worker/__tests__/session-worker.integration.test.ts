import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import pino from "pino";
import IORedis from "ioredis";

import { BullmqSessionQueue } from "../../queue";
import { SessionBufferStore } from "../../session/buffer";
import { InMemoryHistoryStore } from "../../session/history";
import { SessionRepository } from "../../session/repository";
import { buildSessionId } from "../../session/utils";
import type {
  Bot,
  MessageHandler,
  PlatformAdapter,
} from "../../types/platform";
import type { OpencodeRunner, OpencodeRunResult } from "../runner";
import { SessionWorker } from "../worker";

class FakeRunner implements OpencodeRunner {
  async run(): Promise<OpencodeRunResult> {
    return { output: "Test response" };
  }
}

class MemoryAdapter implements PlatformAdapter {
  platform = "test";
  private resolver?: (content: string) => void;
  private promise: Promise<string>;

  constructor() {
    this.promise = new Promise((resolve) => {
      this.resolver = resolve;
    });
  }

  async connect(_bot: Bot): Promise<void> {}

  async disconnect(_bot: Bot): Promise<void> {}

  onEvent(_handler: MessageHandler): void {}

  async sendMessage(
    _session: Parameters<MessageHandler>[0],
    content: string,
  ): Promise<void> {
    this.resolver?.(content);
  }

  getBotUserId(): string | null {
    return null;
  }

  async waitForMessage(timeoutMs: number): Promise<string> {
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

const redisUrl = process.env.REDIS_URL ?? "redis://localhost:6379";
const redisAvailable = await canPingRedis(redisUrl);
const integrationTest = redisAvailable ? test : test.skip;

describe("session worker integration", () => {
  integrationTest("processes job and writes history", async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), "session-worker-"));
    const logger = pino({ level: "silent" });
    const redisUrl = process.env.REDIS_URL ?? "redis://localhost:6379";
    const queueName = `session-test-${Date.now()}`;
    const adapter = new MemoryAdapter();
    const historyStore = new InMemoryHistoryStore();
    const worker = new SessionWorker({
      id: "session-test",
      dataDir: tempDir,
      adapter,
      historyStore,
      redis: {
        url: redisUrl,
      },
      queue: {
        name: queueName,
      },
      runner: new FakeRunner(),
      logger,
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
        channelId: groupId,
        messageId: "msg-1",
        content: "Hello there",
        elements: [{ type: "text", text: "Hello there" }],
        timestamp: Date.now(),
        extras: {},
      } as const;
      await bufferStore.append({ botId: "bot-1", groupId, sessionId }, session);
      await sessionQueue.enqueue({
        botId: "bot-1",
        groupId,
        sessionId,
        userId,
        key,
        gateToken: "gate-token",
      });

      const response = await adapter.waitForMessage(5000);
      expect(response).toBe("Test response");

      const sessionRepository = new SessionRepository({
        dataDir: tempDir,
        logger,
      });
      const sessionInfo = await sessionRepository.loadSession(
        "bot-1",
        groupId,
        userId,
        sessionId,
      );
      expect(sessionInfo).not.toBeNull();
      const history = await historyStore.readHistory(
        { botAccountId: "test:bot-1", userId },
        {
          maxEntries: 20,
        },
      );
      const assistant = history.filter((entry) => entry.role === "assistant");
      expect(assistant.length).toBeGreaterThan(0);
      expect(assistant[assistant.length - 1].content).toBe("Test response");
    } finally {
      await worker.stop();
      await sessionQueue.close();
      await bufferStore.close();
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  integrationTest("normalizes empty input to a single space", async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), "session-worker-"));
    const logger = pino({ level: "silent" });
    const redisUrl = process.env.REDIS_URL ?? "redis://localhost:6379";
    const queueName = `session-empty-test-${Date.now()}`;
    const adapter = new MemoryAdapter();
    const historyStore = new InMemoryHistoryStore();
    const worker = new SessionWorker({
      id: "session-empty-test",
      dataDir: tempDir,
      adapter,
      historyStore,
      redis: {
        url: redisUrl,
      },
      queue: {
        name: queueName,
      },
      runner: new FakeRunner(),
      logger,
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
        channelId: groupId,
        messageId: "msg-1",
        content: "   ",
        elements: [],
        timestamp: Date.now(),
        extras: {},
      } as const;
      await bufferStore.append({ botId: "bot-1", groupId, sessionId }, session);
      await sessionQueue.enqueue({
        botId: "bot-1",
        groupId,
        sessionId,
        userId,
        key,
        gateToken: "gate-token",
      });

      const response = await adapter.waitForMessage(5000);
      expect(response).toContain("Test response");

      const sessionRepository = new SessionRepository({
        dataDir: tempDir,
        logger,
      });
      const sessionInfo = await sessionRepository.loadSession(
        "bot-1",
        groupId,
        userId,
        sessionId,
      );
      expect(sessionInfo).not.toBeNull();
      const history = await historyStore.readHistory(
        { botAccountId: "test:bot-1", userId },
        {
          maxEntries: 20,
        },
      );
      const userEntries = history.filter((entry) => entry.role === "user");
      expect(userEntries[userEntries.length - 1]?.content).toBe(" ");
    } finally {
      await worker.stop();
      await sessionQueue.close();
      await bufferStore.close();
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});

async function canPingRedis(redisUrl: string): Promise<boolean> {
  const client = new IORedis(redisUrl, { maxRetriesPerRequest: 1 });
  client.on("error", () => {});
  try {
    const pong = await client.ping();
    return pong === "PONG";
  } catch {
    return false;
  } finally {
    await client.quit();
  }
}
