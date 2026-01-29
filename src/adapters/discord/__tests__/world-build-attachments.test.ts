import { describe, expect, test } from "bun:test";

import { DiscordAdapter } from "../adapter";

describe("DiscordAdapter world build attachments", () => {
  test("blocks emit when only invalid attachments are provided", async () => {
    const adapter = new DiscordAdapter({ token: "test-token" });
    const sent: string[] = [];
    (adapter as unknown as { sendMessage: unknown }).sendMessage = async (
      _session: unknown,
      content: string,
    ) => {
      sent.push(content);
    };

    const message = {
      attachments: new Map([
        [
          "1",
          {
            url: "",
            name: "world.txt",
            contentType: "text/plain",
            size: 10,
          },
        ],
      ]),
    };
    const session = {
      type: "message",
      platform: "discord",
      selfId: "bot",
      userId: "user",
      channelId: "chan",
      content: "",
      elements: [],
      timestamp: Date.now(),
      extras: {
        messageId: "m",
        channelId: "chan",
        authorId: "user",
      },
    };

    const shouldEmit = await (
      adapter as unknown as {
        ingestWorldBuildAttachments: (
          message: unknown,
          session: unknown,
          parsedWorldGroup: { kind: "build"; worldId: number },
        ) => Promise<boolean>;
      }
    ).ingestWorldBuildAttachments(message, session, {
      kind: "build",
      worldId: 1,
    });

    expect(shouldEmit).toBe(false);
    expect(sent.length).toBe(1);
  }, 10_000);

  test("continues emit when text exists even if attachments are invalid", async () => {
    const adapter = new DiscordAdapter({ token: "test-token" });
    const sent: string[] = [];
    (adapter as unknown as { sendMessage: unknown }).sendMessage = async (
      _session: unknown,
      content: string,
    ) => {
      sent.push(content);
    };

    const message = {
      attachments: new Map([
        [
          "1",
          {
            url: "",
            name: "world.txt",
            contentType: "text/plain",
            size: 10,
          },
        ],
      ]),
    };
    const session = {
      type: "message",
      platform: "discord",
      selfId: "bot",
      userId: "user",
      channelId: "chan",
      content: "some world text",
      elements: [],
      timestamp: Date.now(),
      extras: {
        messageId: "m",
        channelId: "chan",
        authorId: "user",
      },
    };

    const shouldEmit = await (
      adapter as unknown as {
        ingestWorldBuildAttachments: (
          message: unknown,
          session: unknown,
          parsedWorldGroup: { kind: "build"; worldId: number },
        ) => Promise<boolean>;
      }
    ).ingestWorldBuildAttachments(message, session, {
      kind: "build",
      worldId: 1,
    });

    expect(shouldEmit).toBe(true);
    expect(sent.length).toBe(1);
  }, 10_000);
});
