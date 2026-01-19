import { describe, expect, test } from "bun:test";

import type { SessionEvent } from "../../types/platform";
import { resolveDispatchGroupId } from "../message-dispatcher";

const baseMessage: SessionEvent = {
  type: "message",
  platform: "qq",
  selfId: "bot-1",
  userId: "user-1",
  guildId: "guild-1",
  channelId: "channel-1",
  messageId: "msg-1",
  content: "hello",
  elements: [{ type: "text", text: "hello" }],
  timestamp: Date.now(),
  extras: {},
};

describe("resolveDispatchGroupId", () => {
  test("uses guildId by default for guild messages", () => {
    const groupId = resolveDispatchGroupId(baseMessage);
    expect(groupId).toBe("guild-1");
  });

  test("returns forceGroupId when provided", () => {
    const groupId = resolveDispatchGroupId(baseMessage, "forced-group");
    expect(groupId).toBe("forced-group");
  });

  test("returns 0 for direct messages", () => {
    const message: SessionEvent = {
      ...baseMessage,
      guildId: undefined,
      channelId: "dm-1",
    };
    const groupId = resolveDispatchGroupId(message);
    expect(groupId).toBe("0");
  });
});
