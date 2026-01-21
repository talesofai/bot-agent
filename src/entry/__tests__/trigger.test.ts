import { describe, expect, test } from "bun:test";

import { DEFAULT_GROUP_CONFIG, type GroupConfig } from "../../types/group";
import type { SessionEvent } from "../../types/platform";
import {
  extractSessionKey,
  resolveTriggerRule,
  shouldEnqueue,
} from "../trigger";

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
  test("always enqueues direct messages", () => {
    const message: SessionEvent = {
      ...baseMessage,
      guildId: undefined,
      channelId: "dm-1",
      elements: [{ type: "text", text: baseMessage.content }],
    };
    const config = makeConfig({ triggerMode: "mention" });
    const rule = resolveTriggerRule({
      groupConfig: config,
      globalKeywords: [],
      botConfig: undefined,
    });
    const allowed = shouldEnqueue({
      message,
      rule,
    });
    expect(allowed).toBe(true);
  });

  test("matches mention mode", () => {
    const message: SessionEvent = {
      ...baseMessage,
      elements: [
        { type: "mention", userId: baseMessage.selfId },
        { type: "text", text: baseMessage.content },
      ],
    };
    const config = makeConfig({ triggerMode: "mention" });
    const rule = resolveTriggerRule({
      groupConfig: config,
      globalKeywords: [],
      botConfig: undefined,
    });
    const allowed = shouldEnqueue({
      message,
      rule,
    });
    expect(allowed).toBe(true);
  });

  test("mention bypasses bot keyword ownership", () => {
    const message: SessionEvent = {
      ...baseMessage,
      elements: [
        { type: "mention", userId: baseMessage.selfId },
        { type: "text", text: baseMessage.content },
      ],
    };
    const config = makeConfig({ triggerMode: "keyword" });
    const rule = resolveTriggerRule({
      groupConfig: config,
      globalKeywords: [],
      botConfig: {
        keywords: ["bot-a"],
        keywordRouting: DEFAULT_GROUP_CONFIG.keywordRouting,
      },
    });
    const allowed = shouldEnqueue({
      message,
      rule,
    });
    expect(allowed).toBe(true);
  });

  test("matches keyword mode", () => {
    const message: SessionEvent = { ...baseMessage, content: "bot hello" };
    const config = makeConfig({ triggerMode: "keyword", keywords: ["bot"] });
    const rule = resolveTriggerRule({
      groupConfig: config,
      globalKeywords: [],
      botConfig: undefined,
    });
    const allowed = shouldEnqueue({
      message,
      rule,
    });
    expect(allowed).toBe(true);
  });

  test("global keyword is not blocked by other bot keywords", () => {
    const message: SessionEvent = {
      ...baseMessage,
      content: "global-key bot-a",
    };
    const config = makeConfig({ triggerMode: "keyword" });
    const rule = resolveTriggerRule({
      groupConfig: config,
      globalKeywords: ["global-key"],
      botConfig: {
        keywords: ["bot-a"],
        keywordRouting: DEFAULT_GROUP_CONFIG.keywordRouting,
      },
    });
    const allowed = shouldEnqueue({
      message,
      rule,
    });
    expect(allowed).toBe(true);
  });

  test("respects bot keyword ownership", () => {
    const message: SessionEvent = { ...baseMessage, content: "bot-a hello" };
    const config = makeConfig({ triggerMode: "keyword" });
    const rule = resolveTriggerRule({
      groupConfig: config,
      globalKeywords: [],
      botConfig: {
        keywords: ["bot-b"],
        keywordRouting: DEFAULT_GROUP_CONFIG.keywordRouting,
      },
    });
    const allowed = shouldEnqueue({
      message,
      rule,
    });
    expect(allowed).toBe(false);
  });

  test("allows bot keyword match for self", () => {
    const message: SessionEvent = { ...baseMessage, content: "bot-a hello" };
    const config = makeConfig({ triggerMode: "keyword" });
    const rule = resolveTriggerRule({
      groupConfig: config,
      globalKeywords: [],
      botConfig: {
        keywords: ["bot-a"],
        keywordRouting: DEFAULT_GROUP_CONFIG.keywordRouting,
      },
    });
    const allowed = shouldEnqueue({
      message,
      rule,
    });
    expect(allowed).toBe(true);
  });
});

describe("extractSessionKey", () => {
  test("parses #key prefix", () => {
    expect(extractSessionKey("#2 hello")).toEqual({
      key: 2,
      content: "hello",
      prefixLength: 3,
    });
  });

  test("parses #key without trailing content", () => {
    expect(extractSessionKey("#3")).toEqual({
      key: 3,
      content: "",
      prefixLength: 2,
    });
  });

  test("defaults to key 0 on invalid", () => {
    expect(extractSessionKey("#-1 hello")).toEqual({
      key: 0,
      content: "#-1 hello",
      prefixLength: 0,
    });
  });
});
