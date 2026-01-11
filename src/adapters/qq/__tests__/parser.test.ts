import { describe, expect, test, mock, beforeEach, afterEach } from "bun:test";
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

    const result = parseMessage(event, "111111111");

    expect(result).not.toBeNull();
    expect(result!.id).toBe("12345");
    expect(result!.platform).toBe("qq");
    expect(result!.channelId).toBe("987654321");
    expect(result!.userId).toBe("123456789");
    expect(result!.sender.nickname).toBe("TestUser");
    expect(result!.sender.displayName).toBe("Test Display Name");
    expect(result!.sender.role).toBe("member");
    expect(result!.content).toBe("Hello World!");
    expect(result!.mentionsBot).toBe(false);
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

    const result = parseMessage(event, "111111111");

    expect(result).not.toBeNull();
    expect(result!.channelId).toBe("123456789");
    expect(result!.content).toBe("Private message");
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

    const result = parseMessage(event, "111111111");

    expect(result).not.toBeNull();
    expect(result!.mentionsBot).toBe(true);
    expect(result!.content).toBe("Help me");
  });

  test("should return null for non-message events", () => {
    const event = {
      post_type: "meta_event",
      meta_event_type: "heartbeat",
    };

    const result = parseMessage(event, "111111111");

    expect(result).toBeNull();
  });

  test("should return null for invalid event", () => {
    expect(parseMessage(null, "111111111")).toBeNull();
    expect(parseMessage(undefined, "111111111")).toBeNull();
    expect(parseMessage({}, "111111111")).toBeNull();
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

    const result = parseMessage(event, "111111111");

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

    const result = parseMessage(event, "111111111");

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

    const result = parseMessage(event, "111111111");

    expect(result).not.toBeNull();
    expect(result!.content).toBe("Hello from string");
  });

  test("should include channelType in parsed message", () => {
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

    const groupResult = parseMessage(groupEvent, "111111111");
    const privateResult = parseMessage(privateEvent, "111111111");

    expect(groupResult!.channelType).toBe("group");
    expect(privateResult!.channelType).toBe("private");
  });

  test("should detect bot mention in raw_message fallback", () => {
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

    const result = parseMessage(event, "111111111");

    expect(result).not.toBeNull();
    expect(result!.mentionsBot).toBe(true);
    expect(result!.content).toBe("Help me");
  });

  test("should detect bot mention in raw_message with extra CQ params", () => {
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

    const result = parseMessage(event, "111111111");

    expect(result).not.toBeNull();
    expect(result!.mentionsBot).toBe(true);
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
