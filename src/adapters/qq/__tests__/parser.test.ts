import { describe, expect, test } from "bun:test";
import { parseMessage, parseRawMessage } from "../parser";

describe("parseMessage", () => {
  test("should parse group message event correctly", () => {
    const event = {
      post_type: "message",
      message_type: "group",
      message_id: 12345,
      user_id: 123456789,
      group_id: 987654321,
      message: [
        { type: "text", data: { text: "Hello " } },
        { type: "text", data: { text: "World!" } },
      ],
      raw_message: "Hello World!",
      sender: {
        user_id: 123456789,
        nickname: "TestUser",
        card: "Test Display Name",
        role: "member",
      },
      time: 1704067200,
      self_id: 111111111,
    };

    const result = parseMessage(event);

    expect(result).not.toBeNull();
    expect(result!.messageId).toBe("12345");
    expect(result!.platform).toBe("qq");
    expect(result!.channelId).toBe("987654321");
    expect(result!.userId).toBe("123456789");
    expect(result!.selfId).toBe("111111111");
    expect(result!.guildId).toBe("987654321");
    expect(result!.content).toBe("Hello World!");
    expect(result!.elements).toEqual([
      { type: "text", text: "Hello " },
      { type: "text", text: "World!" },
    ]);
    expect(result!.timestamp).toBe(1704067200000);
  });

  test("should parse private message event correctly", () => {
    const event = {
      post_type: "message",
      message_type: "private",
      message_id: 54321,
      user_id: 123456789,
      message: [{ type: "text", data: { text: "Private message" } }],
      raw_message: "Private message",
      sender: {
        user_id: 123456789,
        nickname: "PrivateUser",
      },
      time: 1704067200,
      self_id: 111111111,
    };

    const result = parseMessage(event);

    expect(result).not.toBeNull();
    expect(result!.channelId).toBe("123456789");
    expect(result!.content).toBe("Private message");
    expect(result!.guildId).toBeUndefined();
  });

  test("should detect bot mention correctly", () => {
    const event = {
      post_type: "message",
      message_type: "group",
      message_id: 12345,
      user_id: 123456789,
      group_id: 987654321,
      message: [
        { type: "at", data: { qq: 111111111 } },
        { type: "text", data: { text: " Help me" } },
      ],
      raw_message: "[CQ:at,qq=111111111] Help me",
      sender: {
        user_id: 123456789,
        nickname: "TestUser",
      },
      time: 1704067200,
      self_id: 111111111,
    };

    const result = parseMessage(event);

    expect(result).not.toBeNull();
    expect(result!.elements).toEqual([
      { type: "mention", userId: "111111111" },
      { type: "text", text: " Help me" },
    ]);
    expect(result!.content).toBe("Help me");
  });

  test("should return null for non-message events", () => {
    const event = {
      post_type: "meta_event",
      meta_event_type: "heartbeat",
    };

    const result = parseMessage(event);

    expect(result).toBeNull();
  });

  test("should return null for invalid event", () => {
    expect(parseMessage(null)).toBeNull();
    expect(parseMessage(undefined)).toBeNull();
    expect(parseMessage({})).toBeNull();
  });

  test("should handle empty message array", () => {
    const event = {
      post_type: "message",
      message_type: "group",
      message_id: 12345,
      user_id: 123456789,
      group_id: 987654321,
      message: [],
      raw_message: "",
      sender: {
        user_id: 123456789,
        nickname: "EmptyUser",
      },
      time: 1704067200,
      self_id: 111111111,
    };

    const result = parseMessage(event);

    expect(result).not.toBeNull();
    expect(result!.content).toBe("");
  });

  test("should fallback to raw_message when message is undefined", () => {
    const event = {
      post_type: "message",
      message_type: "group",
      message_id: 12345,
      user_id: 123456789,
      group_id: 987654321,
      raw_message: "Fallback content",
      sender: {
        user_id: 123456789,
        nickname: "FallbackUser",
      },
      time: 1704067200,
      self_id: 111111111,
    };

    const result = parseMessage(event);

    expect(result).not.toBeNull();
    expect(result!.content).toBe("Fallback content");
  });

  test("should handle message as string", () => {
    const event = {
      post_type: "message",
      message_type: "private",
      message_id: 12345,
      user_id: 123456789,
      message: "[CQ:at,qq=111]Hello from string",
      sender: {
        user_id: 123456789,
        nickname: "StringUser",
      },
      time: 1704067200,
      self_id: 111111111,
    };

    const result = parseMessage(event);

    expect(result).not.toBeNull();
    expect(result!.content).toBe("Hello from string");
  });

  test("should set guildId for group messages only", () => {
    const groupEvent = {
      post_type: "message",
      message_type: "group",
      message_id: 12345,
      user_id: 123456789,
      group_id: 987654321,
      message: [{ type: "text", data: { text: "Group msg" } }],
      sender: { user_id: 123456789, nickname: "User" },
      time: 1704067200,
      self_id: 111111111,
    };

    const privateEvent = {
      post_type: "message",
      message_type: "private",
      message_id: 12346,
      user_id: 123456789,
      message: [{ type: "text", data: { text: "Private msg" } }],
      sender: { user_id: 123456789, nickname: "User" },
      time: 1704067200,
      self_id: 111111111,
    };

    const groupResult = parseMessage(groupEvent);
    const privateResult = parseMessage(privateEvent);

    expect(groupResult!.guildId).toBe("987654321");
    expect(privateResult!.guildId).toBeUndefined();
  });

  test("should parse mentions from raw_message fallback", () => {
    const event = {
      post_type: "message",
      message_type: "group",
      message_id: 12345,
      user_id: 123456789,
      group_id: 987654321,
      raw_message: "[CQ:at,qq=111111111] Help me",
      sender: { user_id: 123456789, nickname: "User" },
      time: 1704067200,
      self_id: 111111111,
    };

    const result = parseMessage(event);

    expect(result).not.toBeNull();
    expect(result!.elements).toEqual([
      { type: "mention", userId: "111111111" },
      { type: "text", text: "Help me" },
    ]);
    expect(result!.content).toBe("Help me");
  });

  test("should parse mentions with extra CQ params", () => {
    const event = {
      post_type: "message",
      message_type: "group",
      message_id: 12345,
      user_id: 123456789,
      group_id: 987654321,
      raw_message: "[CQ:at,qq=111111111,name=Bot] Help me",
      sender: { user_id: 123456789, nickname: "User" },
      time: 1704067200,
      self_id: 111111111,
    };

    const result = parseMessage(event);

    expect(result).not.toBeNull();
    expect(result!.elements[0]).toEqual({
      type: "mention",
      userId: "111111111",
    });
  });
});

describe("parseRawMessage", () => {
  test("should strip CQ codes from raw message", () => {
    const raw = "[CQ:at,qq=123456]Hello[CQ:image,file=abc.jpg]";
    const result = parseRawMessage(raw);
    expect(result).toBe("Hello");
  });

  test("should handle message without CQ codes", () => {
    const raw = "Plain text message";
    const result = parseRawMessage(raw);
    expect(result).toBe("Plain text message");
  });

  test("should trim whitespace", () => {
    const raw = "  Some text  ";
    const result = parseRawMessage(raw);
    expect(result).toBe("Some text");
  });
});
