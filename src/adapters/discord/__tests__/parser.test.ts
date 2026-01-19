import { describe, expect, test } from "bun:test";
import type { Message } from "discord.js";
import { parseMessage } from "../parser";

function createDiscordMessage({
  botId,
  authorId,
  content,
  mentions = [],
  repliedUserId,
}: {
  botId: string;
  authorId: string;
  content: string;
  mentions?: string[];
  repliedUserId?: string;
}): Message {
  const mentionEntries: Array<[string, { id: string }]> = mentions.map((id) => [
    id,
    { id },
  ]);
  return {
    author: { bot: false, id: authorId },
    client: { user: { id: botId } },
    content,
    mentions: {
      users: new Map(mentionEntries),
      repliedUser: repliedUserId ? { id: repliedUserId } : null,
    },
    attachments: new Map(),
    guildId: "guild-1",
    channelId: "channel-1",
    id: "message-1",
    createdTimestamp: 1700000000000,
  } as unknown as Message;
}

describe("parseMessage", () => {
  test("parses direct @ mention", () => {
    const botId = "123";
    const message = createDiscordMessage({
      botId,
      authorId: "user-1",
      content: `<@${botId}> 你好`,
      mentions: [botId],
    });

    const parsed = parseMessage(message, botId);
    expect(parsed).not.toBeNull();
    expect(parsed?.elements).toContainEqual({ type: "mention", userId: botId });
    expect(parsed?.content).toBe("你好");
  });

  test("treats reply-to-bot as a mention trigger", () => {
    const botId = "123";
    const message = createDiscordMessage({
      botId,
      authorId: "user-1",
      content: "你好",
      repliedUserId: botId,
    });

    const parsed = parseMessage(message, botId);
    expect(parsed).not.toBeNull();
    expect(parsed?.elements).toContainEqual({ type: "mention", userId: botId });
    expect(parsed?.content).toBe("你好");
  });

  test("does not trigger on reply-to-others", () => {
    const botId = "123";
    const message = createDiscordMessage({
      botId,
      authorId: "user-1",
      content: "你好",
      repliedUserId: "999",
    });

    const parsed = parseMessage(message, botId);
    expect(parsed).not.toBeNull();
    expect(
      parsed?.elements.some(
        (element) => element.type === "mention" && element.userId === botId,
      ),
    ).toBe(false);
  });
});
