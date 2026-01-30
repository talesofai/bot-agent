import { describe, expect, test } from "bun:test";
import type { ChatInputCommandInteraction } from "discord.js";

import type { SessionEvent } from "../../../types/platform";
import { DiscordAdapter } from "../adapter";

describe("DiscordAdapter interaction replies", () => {
  test("edits /reset reply instead of sending a public channel message", async () => {
    const adapter = new DiscordAdapter({ token: "test-token" });

    const edits: string[] = [];
    const interaction = {
      id: "i_reset_1",
      commandName: "reset",
      replied: true,
      deferred: false,
      channelId: "c1",
      guildId: "g1",
      user: { id: "u1" },
      editReply: async (payload: { content: string }) => {
        edits.push(payload.content);
      },
      reply: async () => {},
      followUp: async () => {},
    } as unknown as ChatInputCommandInteraction;

    (
      adapter as unknown as {
        pendingInteractionReplies: Map<
          string,
          { interaction: ChatInputCommandInteraction; createdAtMs: number }
        >;
      }
    ).pendingInteractionReplies.set(interaction.id, {
      interaction,
      createdAtMs: Date.now(),
    });

    const session: SessionEvent = {
      type: "message",
      platform: "discord",
      selfId: "bot",
      userId: "u1",
      guildId: "g1",
      channelId: "c1",
      messageId: "i_reset_1",
      content: "/reset",
      elements: [],
      timestamp: Date.now(),
      extras: {
        interactionId: "i_reset_1",
        commandName: "reset",
      },
    };

    await adapter.sendMessage(session, "已重置对话（key=0）。");
    expect(edits).toEqual(["已重置对话（key=0）。"]);
  });
});
