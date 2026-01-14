import { describe, expect, test } from "bun:test";

import { EchoTracker } from "../echo";
import type { SessionEvent } from "../../types/platform";

const baseMessage: SessionEvent = {
  type: "message",
  platform: "qq",
  selfId: "bot-1",
  channelId: "group-1",
  guildId: "group-1",
  userId: "user-1",
  messageId: "msg-1",
  content: "hello",
  elements: [{ type: "text", text: "hello" }],
  timestamp: 0,
  extras: {},
};

describe("EchoTracker", () => {
  test("does not echo for mentions", async () => {
    const tracker = createTracker();
    const message: SessionEvent = {
      ...baseMessage,
      elements: [{ type: "mention", userId: "someone" }],
      content: "@someone hello",
    };
    expect(await tracker.shouldEcho(message, 30)).toBe(false);
  });

  test("does not echo for direct messages", async () => {
    const tracker = createTracker();
    const message = { ...baseMessage, guildId: undefined };
    expect(await tracker.shouldEcho(message, 30)).toBe(false);
  });

  test("mentions break streaks", async () => {
    const tracker = createTracker();
    const originalRandom = Math.random;
    Math.random = () => 0;
    try {
      expect(await tracker.shouldEcho(baseMessage, 30)).toBe(false);
      const mentionMessage: SessionEvent = {
        ...baseMessage,
        elements: [{ type: "mention", userId: "someone" }],
        content: "@someone hello",
      };
      expect(await tracker.shouldEcho(mentionMessage, 30)).toBe(false);
      expect(await tracker.shouldEcho(baseMessage, 30)).toBe(false);
    } finally {
      Math.random = originalRandom;
    }
  });

  test("respects echo rate", async () => {
    const tracker = createTracker();
    const originalRandom = Math.random;
    Math.random = () => 0;
    try {
      expect(await tracker.shouldEcho(baseMessage, 0)).toBe(false);
      expect(await tracker.shouldEcho(baseMessage, 30)).toBe(true);
    } finally {
      Math.random = originalRandom;
    }
  });

  test("does not share streaks across channels", async () => {
    const tracker = createTracker();
    const originalRandom = Math.random;
    Math.random = () => 0;
    try {
      expect(await tracker.shouldEcho(baseMessage, 30)).toBe(false);
      expect(await tracker.shouldEcho(baseMessage, 30)).toBe(true);
      const otherChannel: SessionEvent = {
        ...baseMessage,
        channelId: "group-2",
      };
      expect(await tracker.shouldEcho(otherChannel, 30)).toBe(false);
    } finally {
      Math.random = originalRandom;
    }
  });

  test("ignores plain @ text for mentions", async () => {
    const tracker = createTracker();
    const message: SessionEvent = {
      ...baseMessage,
      content: "contact test@example.com",
      elements: [{ type: "text", text: "contact test@example.com" }],
    };
    const originalRandom = Math.random;
    Math.random = () => 0;
    try {
      expect(await tracker.shouldEcho(message, 30)).toBe(false);
      expect(await tracker.shouldEcho(message, 30)).toBe(true);
    } finally {
      Math.random = originalRandom;
    }
  });
});

function createTracker(): EchoTracker {
  return new EchoTracker({ store: new MemoryEchoStore() });
}

class MemoryEchoStore {
  private store = new Map<string, string>();

  async get(key: string): Promise<string | null> {
    return this.store.get(key) ?? null;
  }

  async set(key: string, value: string, _ttlSeconds?: number): Promise<void> {
    this.store.set(key, value);
  }

  async del(key: string): Promise<void> {
    this.store.delete(key);
  }

  async close(): Promise<void> {}
}
