import { describe, expect, test } from "bun:test";

import type { SessionEvent } from "../../types/platform";
import { DEFAULT_GROUP_CONFIG } from "../../types/group";
import { routeDispatch } from "../dispatch-plan";

describe("routeDispatch dice", () => {
  test("routes dice even when triggerMode is mention and message is not a mention", () => {
    const message: SessionEvent = {
      type: "message",
      platform: "discord",
      selfId: "bot",
      userId: "user",
      guildId: "guild",
      channelId: "channel",
      messageId: "msg",
      content: "2d100",
      elements: [{ type: "text", text: "2d100" }],
      timestamp: Date.now(),
      extras: {},
    };

    const routing = routeDispatch({
      message,
      groupConfig: { ...DEFAULT_GROUP_CONFIG, triggerMode: "mention" },
      routerSnapshot: null,
      botId: "bot",
    });

    expect(routing.kind).toBe("dice");
    if (routing.kind !== "dice") {
      throw new Error("expected dice routing");
    }
    expect(routing.dice).toEqual({ count: 2, sides: 100 });
  });

  test("drops dice messages when session key exceeds maxSessions", () => {
    const message: SessionEvent = {
      type: "message",
      platform: "discord",
      selfId: "bot",
      userId: "user",
      guildId: "guild",
      channelId: "channel",
      messageId: "msg",
      content: "#2 2d6",
      elements: [{ type: "text", text: "#2 2d6" }],
      timestamp: Date.now(),
      extras: {},
    };

    const routing = routeDispatch({
      message,
      groupConfig: { ...DEFAULT_GROUP_CONFIG, triggerMode: "mention" },
      routerSnapshot: null,
      botId: "bot",
    });

    expect(routing.kind).toBe("drop");
    if (routing.kind !== "drop") {
      throw new Error("expected drop routing");
    }
    expect(routing.reason).toBe("session_key_exceeds_max_sessions");
  });

  test("routes dice with session key within range", () => {
    const message: SessionEvent = {
      type: "message",
      platform: "discord",
      selfId: "bot",
      userId: "user",
      guildId: "guild",
      channelId: "channel",
      messageId: "msg",
      content: "#0 10d20",
      elements: [{ type: "text", text: "#0 10d20" }],
      timestamp: Date.now(),
      extras: {},
    };

    const routing = routeDispatch({
      message,
      groupConfig: { ...DEFAULT_GROUP_CONFIG, triggerMode: "mention" },
      routerSnapshot: null,
      botId: "bot",
    });

    expect(routing.kind).toBe("dice");
    if (routing.kind !== "dice") {
      throw new Error("expected dice routing");
    }
    expect(routing.dice).toEqual({ count: 10, sides: 20 });
  });
});

describe("routeDispatch nano", () => {
  test("enqueues /nano even when triggerMode is mention and message is not a mention", () => {
    const message: SessionEvent = {
      type: "message",
      platform: "discord",
      selfId: "bot",
      userId: "user",
      guildId: "guild",
      channelId: "channel",
      messageId: "msg",
      content: "/nano a cute cat",
      elements: [{ type: "text", text: "/nano a cute cat" }],
      timestamp: Date.now(),
      extras: {},
    };

    const routing = routeDispatch({
      message,
      groupConfig: { ...DEFAULT_GROUP_CONFIG, triggerMode: "mention" },
      routerSnapshot: null,
      botId: "bot",
    });

    expect(routing.kind).toBe("enqueue");
  });
});
