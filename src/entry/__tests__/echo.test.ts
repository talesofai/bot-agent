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
  test("does not echo for mentions", () => {
    const tracker = new EchoTracker();
    const message = {
      ...baseMessage,
      elements: [{ type: "mention", userId: "someone" }],
      content: "@someone hello",
    };
    expect(tracker.shouldEcho(message, 30)).toBe(false);
  });

  test("does not echo for direct messages", () => {
    const tracker = new EchoTracker();
    const message = { ...baseMessage, guildId: undefined };
    expect(tracker.shouldEcho(message, 30)).toBe(false);
  });

  test("respects echo rate", () => {
    const tracker = new EchoTracker();
    const originalRandom = Math.random;
    Math.random = () => 0;
    try {
      expect(tracker.shouldEcho(baseMessage, 0)).toBe(false);
      expect(tracker.shouldEcho(baseMessage, 30)).toBe(true);
      expect(tracker.shouldEcho(baseMessage, 30)).toBe(false);
    } finally {
      Math.random = originalRandom;
    }
  });
});
