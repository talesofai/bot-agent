import { describe, expect, test } from "bun:test";
import pino from "pino";

import { BullmqResponseQueue } from "../../queue/response-queue";
import type {
  ConnectionHandler,
  MessageHandler,
  PlatformAdapter,
  SendMessageOptions,
} from "../../types/platform";
import { ResponseWorker } from "../response-worker";

class MockAdapter implements PlatformAdapter {
  platform = "mock";
  private connectHandlers: ConnectionHandler[] = [];
  private disconnectHandlers: ConnectionHandler[] = [];
  private messageHandlers: MessageHandler[] = [];
  private onSend?: (options: SendMessageOptions) => void;

  setSendHandler(handler: (options: SendMessageOptions) => void): void {
    this.onSend = handler;
  }

  async connect(): Promise<void> {
    for (const handler of this.connectHandlers) {
      handler();
    }
  }

  async disconnect(): Promise<void> {
    for (const handler of this.disconnectHandlers) {
      handler();
    }
  }

  onMessage(handler: MessageHandler): void {
    this.messageHandlers.push(handler);
  }

  onConnect(handler: ConnectionHandler): void {
    this.connectHandlers.push(handler);
  }

  onDisconnect(handler: ConnectionHandler): void {
    this.disconnectHandlers.push(handler);
  }

  async sendMessage(options: SendMessageOptions): Promise<void> {
    this.onSend?.(options);
  }

  getBotUserId(): string | null {
    return null;
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

describe("response worker integration", () => {
  integrationTest("delivers response jobs to adapter", async () => {
    const redisUrl = process.env.REDIS_URL ?? "redis://localhost:6379";
    const queueName = `response-test-${Date.now()}`;
    const logger = pino({ level: "silent" });
    const adapter = new MockAdapter();
    const responseQueue = new BullmqResponseQueue({
      redisUrl,
      queueName,
    });
    const responseWorker = new ResponseWorker({
      id: "response-test",
      queueName,
      redisUrl,
      adapter,
      logger,
    });

    const received = new Promise<SendMessageOptions>((resolve) => {
      adapter.setSendHandler(resolve);
    });

    try {
      responseWorker.start();
      await responseQueue.enqueue({
        channelId: "channel-1",
        channelType: "group",
        content: "hello from response worker",
        groupId: "group-1",
        userId: "user-1",
        sessionId: "session-1",
      });

      const message = await withTimeout(received, 5000);
      expect(message.channelId).toBe("channel-1");
      expect(message.channelType).toBe("group");
      expect(message.content).toBe("hello from response worker");
    } finally {
      await responseWorker.stop();
      await responseQueue.close();
    }
  });
});
