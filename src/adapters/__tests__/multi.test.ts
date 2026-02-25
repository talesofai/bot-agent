import { describe, expect, test } from "bun:test";

import { MultiAdapter } from "../multi";
import type {
  Bot,
  MessageHandler,
  PlatformAdapter,
  SendMessageOptions,
  SessionEvent,
} from "../../types/platform";

class FakeAdapter implements PlatformAdapter {
  readonly platform: string;

  constructor(platform: string) {
    this.platform = platform;
  }

  async connect(_bot: Bot): Promise<void> {}

  async disconnect(_bot: Bot): Promise<void> {}

  onEvent(_handler: MessageHandler): void {}

  async sendMessage(
    _session: SessionEvent,
    _content: string,
    _options?: SendMessageOptions,
  ): Promise<void> {}

  getBotUserId(): string | null {
    return null;
  }
}

function buildSession(platform: string): SessionEvent {
  return {
    type: "message",
    platform,
    selfId: "bot",
    userId: "user",
    guildId: "guild",
    channelId: "channel",
    messageId: "m1",
    content: "hi",
    elements: [{ type: "text", text: "hi" }],
    timestamp: Date.now(),
    extras: {},
  };
}

describe("MultiAdapter", () => {
  test("forwards suggested command actions to matched platform adapter", async () => {
    const discord = new FakeAdapter("discord");
    let called = false;
    (
      discord as PlatformAdapter & {
        sendSuggestedCommandActions?: (input: unknown) => Promise<boolean>;
      }
    ).sendSuggestedCommandActions = async () => {
      called = true;
      return true;
    };

    const adapter = new MultiAdapter({ adapters: [discord] });
    const sent = await (
      adapter as MultiAdapter & {
        sendSuggestedCommandActions: (input: {
          session: SessionEvent;
          prompt?: string;
          actions: Array<{ action: string; label?: string; payload?: string }>;
        }) => Promise<boolean>;
      }
    ).sendSuggestedCommandActions({
      session: buildSession("discord"),
      prompt: "next",
      actions: [{ action: "help", label: "帮助" }],
    });

    expect(sent).toBe(true);
    expect(called).toBe(true);
  });

  test("returns false when matched platform adapter has no suggested-action sender", async () => {
    const discord = new FakeAdapter("discord");
    const adapter = new MultiAdapter({ adapters: [discord] });

    const sent = await (
      adapter as MultiAdapter & {
        sendSuggestedCommandActions: (input: {
          session: SessionEvent;
          prompt?: string;
          actions: Array<{ action: string; label?: string; payload?: string }>;
        }) => Promise<boolean>;
      }
    ).sendSuggestedCommandActions({
      session: buildSession("discord"),
      actions: [{ action: "help" }],
    });

    expect(sent).toBe(false);
  });
});
