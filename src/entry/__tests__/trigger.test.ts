import { describe, expect, test } from "bun:test";

import { DEFAULT_GROUP_CONFIG, type GroupConfig } from "../../types/group";
import type { SessionEvent } from "../../types/platform";
import { extractSessionKey, shouldEnqueue } from "../trigger";

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

function makeConfig(overrides: Partial<GroupConfig>): GroupConfig {
  return { ...DEFAULT_GROUP_CONFIG, ...overrides };
}

describe("shouldEnqueue", () => {
  test("matches mention mode", () => {
    const message = {
      ...baseMessage,
      elements: [
        { type: "mention", userId: baseMessage.selfId },
        { type: "text", text: baseMessage.content },
      ],
    };
    const config = makeConfig({ triggerMode: "mention" });
    const allowed = shouldEnqueue({
      groupConfig: config,
      message,
      keywordMatched: false,
      botKeywordMatches: new Set(),
    });
    expect(allowed).toBe(true);
  });

  test("mention bypasses bot keyword ownership", () => {
    const message = {
      ...baseMessage,
      elements: [
        { type: "mention", userId: baseMessage.selfId },
        { type: "text", text: baseMessage.content },
      ],
    };
    const config = makeConfig({ triggerMode: "keyword" });
    const allowed = shouldEnqueue({
      groupConfig: config,
      message,
      keywordMatched: false,
      botKeywordMatches: new Set(["bot-2"]),
    });
    expect(allowed).toBe(true);
  });

  test("matches keyword mode", () => {
    const message = { ...baseMessage, content: "Hello Bot" };
    const config = makeConfig({ triggerMode: "keyword", keywords: ["bot"] });
    const allowed = shouldEnqueue({
      groupConfig: config,
      message,
      keywordMatched: true,
      botKeywordMatches: new Set(),
    });
    expect(allowed).toBe(true);
  });

  test("respects bot keyword ownership", () => {
    const message = { ...baseMessage, content: "hello bot-a" };
    const config = makeConfig({ triggerMode: "keyword" });
    const allowed = shouldEnqueue({
      groupConfig: config,
      message,
      keywordMatched: true,
      botKeywordMatches: new Set(["bot-2"]),
    });
    expect(allowed).toBe(false);
  });

  test("allows bot keyword match for self", () => {
    const message = { ...baseMessage, content: "hello bot-a" };
    const config = makeConfig({ triggerMode: "keyword" });
    const allowed = shouldEnqueue({
      groupConfig: config,
      message,
      keywordMatched: true,
      botKeywordMatches: new Set([baseMessage.selfId]),
    });
    expect(allowed).toBe(true);
  });
});

describe("extractSessionKey", () => {
  test("parses #key prefix", () => {
    expect(extractSessionKey("#2 hello")).toEqual({
      key: 2,
      content: "hello",
    });
  });

  test("parses #key without trailing content", () => {
    expect(extractSessionKey("#3")).toEqual({
      key: 3,
      content: "",
    });
  });

  test("defaults to key 0 on invalid", () => {
    expect(extractSessionKey("#-1 hello")).toEqual({
      key: 0,
      content: "#-1 hello",
    });
  });
});
