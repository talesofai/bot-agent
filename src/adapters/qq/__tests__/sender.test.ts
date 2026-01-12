import { describe, expect, test, mock, beforeEach } from "bun:test";
import type { Logger } from "pino";
import type { MilkyConnection } from "../connection";
import { MessageSender } from "../sender";
import type { SendMessageOptions } from "../../../types/platform";

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

  test("should require channelType", async () => {
    const sender = createSender();
    const options = {
      channelId: "123",
      content: "hello",
    } as SendMessageOptions;

    await expect(sender.send(options)).rejects.toThrow("channelType is required");
  });

  test("should require channelId", async () => {
    const sender = createSender();
    const options = {
      channelId: "",
      channelType: "group",
      content: "hello",
    };

    await expect(sender.send(options)).rejects.toThrow("channelId is required");
  });

  test("should send group message with string id", async () => {
    const sender = createSender();
    const options: SendMessageOptions = {
      channelId: "456",
      channelType: "group",
      content: "hi",
    };

    await sender.send(options);

    expect(sendRequestMock).toHaveBeenCalledTimes(1);
    expect(sendRequestMock).toHaveBeenCalledWith("send_group_msg", {
      group_id: "456",
      message: [{ type: "text", data: { text: "hi" } }],
    });
  });

  test("should send private message with attachments", async () => {
    const sender = createSender();
    const options: SendMessageOptions = {
      channelId: "789",
      channelType: "private",
      content: "hello",
      attachments: [
        { type: "image", url: "https://example.com/a.png" },
        { type: "file", url: "https://example.com/a.txt", name: "a.txt" },
      ],
    };

    await sender.send(options);

    expect(sendRequestMock).toHaveBeenCalledTimes(1);
    expect(sendRequestMock).toHaveBeenCalledWith("send_private_msg", {
      user_id: "789",
      message: [
        { type: "text", data: { text: "hello" } },
        { type: "image", data: { file: "https://example.com/a.png" } },
        { type: "text", data: { text: "\n[File: a.txt]" } },
      ],
    });
  });
});
