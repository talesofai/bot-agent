import { describe, expect, test } from "bun:test";

import { DEFAULT_GROUP_CONFIG, type GroupConfig } from "../../types/group";
import type { UnifiedMessage } from "../../types/platform";
import { extractSessionKey, shouldEnqueue } from "../trigger";

const baseMessage: UnifiedMessage = {
  id: "msg-1",
  platform: "qq",
  channelId: "group-1",
  userId: "user-1",
  sender: {
    nickname: "tester",
    displayName: "Tester",
    role: "member",
  },
  content: "hello",
  mentionsBot: false,
  timestamp: 0,
  raw: {},
};

function makeConfig(overrides: Partial<GroupConfig>): GroupConfig {
  return { ...DEFAULT_GROUP_CONFIG, ...overrides };
}

describe("shouldEnqueue", () => {
  test("matches mention mode", () => {
    const message = { ...baseMessage, mentionsBot: true };
    const config = makeConfig({ triggerMode: "mention" });
    const allowed = shouldEnqueue({
      groupId: "group-1",
      groupConfig: config,
      message,
      context: { cooldowns: new Map() },
    });
    expect(allowed).toBe(true);
  });

  test("matches keyword mode", () => {
    const message = { ...baseMessage, content: "Hello Bot" };
    const config = makeConfig({ triggerMode: "keyword", keywords: ["bot"] });
    const allowed = shouldEnqueue({
      groupId: "group-1",
      groupConfig: config,
      message,
      context: { cooldowns: new Map() },
    });
    expect(allowed).toBe(true);
  });

  test("respects cooldown for non-admin users", () => {
    let now = 1000;
    const context = { cooldowns: new Map<string, number>(), now: () => now };
    const message = { ...baseMessage, mentionsBot: true };
    const config = makeConfig({ triggerMode: "mention", cooldown: 10 });
    expect(
      shouldEnqueue({
        groupId: "group-1",
        groupConfig: config,
        message,
        context,
      }),
    ).toBe(true);
    now += 2000;
    expect(
      shouldEnqueue({
        groupId: "group-1",
        groupConfig: config,
        message,
        context,
      }),
    ).toBe(false);
  });

  test("admin bypasses cooldown after trigger match", () => {
    let now = 1000;
    const context = { cooldowns: new Map<string, number>(), now: () => now };
    const message = { ...baseMessage, mentionsBot: true, userId: "admin-1" };
    const config = makeConfig({
      triggerMode: "mention",
      cooldown: 10,
      adminUsers: ["admin-1"],
    });
    expect(
      shouldEnqueue({
        groupId: "group-1",
        groupConfig: config,
        message,
        context,
      }),
    ).toBe(true);
    now += 2000;
    expect(
      shouldEnqueue({
        groupId: "group-1",
        groupConfig: config,
        message,
        context,
      }),
    ).toBe(true);
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
