import { describe, expect, test } from "bun:test";
import pino from "pino";

import { BullmqResponseQueue } from "../../queue/response-queue";
import type {
  Bot,
  MessageHandler,
  PlatformAdapter,
} from "../../types/platform";
import { ResponseWorker } from "../response-worker";

class MockAdapter implements PlatformAdapter {
  platform = "mock";
  private messageHandlers: MessageHandler[] = [];
  private onSend?: (content: string) => void;

  setSendHandler(handler: (content: string) => void): void {
    this.onSend = handler;
  }

  async connect(_bot: Bot): Promise<void> {}

  async disconnect(_bot: Bot): Promise<void> {}

  onEvent(handler: MessageHandler): void {
    this.messageHandlers.push(handler);
  }

  async sendMessage(
    _session: Parameters<MessageHandler>[0],
    content: string,
    _options?: Parameters<PlatformAdapter["sendMessage"]>[2],
  ): Promise<void> {
    this.onSend?.(content);
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

    const received = new Promise<string>((resolve) => {
      adapter.setSendHandler(resolve);
    });

    try {
      responseWorker.start();
      await responseQueue.enqueue({
        content: "hello from response worker",
        session: {
          type: "message",
          platform: "mock",
          selfId: "bot-1",
          userId: "user-1",
          guildId: "group-1",
          channelId: "channel-1",
          messageId: "msg-1",
          content: "hello",
          elements: [{ type: "text", text: "hello" }],
          timestamp: Date.now(),
          extras: {},
        },
      });

      const message = await withTimeout(received, 5000);
      expect(message).toBe("hello from response worker");
    } finally {
      await responseWorker.stop();
      await responseQueue.close();
    }
  });
});
