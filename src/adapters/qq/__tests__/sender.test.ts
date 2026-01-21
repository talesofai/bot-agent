import { describe, expect, test, mock, beforeEach } from "bun:test";
import type { Logger } from "pino";
import type { MilkyConnection } from "../connection";
import { MessageSender } from "../sender";
import type { SendMessageOptions, SessionEvent } from "../../../types/platform";

const createMockLogger = () => {
  const mockLogger = {
    debug: mock(() => {}),
    info: mock(() => {}),
    warn: mock(() => {}),
    error: mock(() => {}),
    child: mock(() => mockLogger),
  } as unknown as Logger;
  return mockLogger;
};

describe("MessageSender", () => {
  let mockLogger: Logger;
  let sendRequestMock: ReturnType<typeof mock>;

  beforeEach(() => {
    mockLogger = createMockLogger();
    sendRequestMock = mock(async () => {});
  });

  const createSender = () => {
    const connection = {
      sendRequest: sendRequestMock,
    } as unknown as MilkyConnection;
    return new MessageSender(connection, mockLogger);
  };

  test("should require channelId", async () => {
    const sender = createSender();
    const session: SessionEvent = {
      type: "message",
      platform: "qq",
      selfId: "bot-1",
      userId: "user-1",
      guildId: "group-1",
      channelId: "",
      messageId: "101",
      content: "hello",
      elements: [{ type: "text", text: "hello" }],
      timestamp: 0,
      extras: {},
    };

    await expect(sender.send(session, "hello")).rejects.toThrow(
      "channelId is required",
    );
  });

  test("should send group message with string id", async () => {
    const sender = createSender();
    const session: SessionEvent = {
      type: "message",
      platform: "qq",
      selfId: "bot-1",
      userId: "user-1",
      guildId: "456",
      channelId: "456",
      messageId: "101",
      content: "hi",
      elements: [{ type: "text", text: "hi" }],
      timestamp: 0,
      extras: {},
    };

    await sender.send(session, "hi");

    expect(sendRequestMock).toHaveBeenCalledTimes(1);
    expect(sendRequestMock).toHaveBeenCalledWith("send_group_msg", {
      group_id: "456",
      message: [
        { type: "reply", data: { id: "101" } },
        { type: "text", data: { text: "hi" } },
      ],
    });
  });

  test("should send private message with elements", async () => {
    const sender = createSender();
    const session: SessionEvent = {
      type: "message",
      platform: "qq",
      selfId: "bot-1",
      userId: "user-1",
      channelId: "789",
      messageId: "101",
      content: "hello",
      elements: [{ type: "text", text: "hello" }],
      timestamp: 0,
      extras: {},
    };
    const options: SendMessageOptions = {
      elements: [
        { type: "text", text: "hello" },
        { type: "image", url: "https://example.com/a.png" },
        { type: "quote", messageId: "909" },
      ],
    };

    await sender.send(session, "hello", options);

    expect(sendRequestMock).toHaveBeenCalledTimes(1);
    expect(sendRequestMock).toHaveBeenCalledWith("send_private_msg", {
      user_id: "789",
      message: [
        { type: "reply", data: { id: "909" } },
        { type: "text", data: { text: "hello" } },
        { type: "image", data: { file: "https://example.com/a.png" } },
      ],
    });
  });
});
