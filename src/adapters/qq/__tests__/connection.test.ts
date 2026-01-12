import { describe, expect, test, mock, beforeEach } from "bun:test";
import { MilkyConnection } from "../connection";
import type { Logger } from "pino";

// Create a mock logger
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

describe("MilkyConnection", () => {
  let mockLogger: Logger;
  let onEventMock: ReturnType<typeof mock>;
  let onBotIdMock: ReturnType<typeof mock>;

  beforeEach(() => {
    mockLogger = createMockLogger();
    onEventMock = mock(async () => {});
    onBotIdMock = mock(() => {});
  });

  test("should create connection instance correctly", () => {
    const connection = new MilkyConnection({
      url: "ws://localhost:3000",
      logger: mockLogger,
      onEvent: onEventMock,
      onBotId: onBotIdMock,
    });

    expect(connection).toBeDefined();
    expect(connection.isConnected()).toBe(false);
  });

  test("should report not connected initially", () => {
    const connection = new MilkyConnection({
      url: "ws://localhost:3000",
      logger: mockLogger,
      onEvent: onEventMock,
    });

    expect(connection.isConnected()).toBe(false);
  });

  test("should throw error when sending request while disconnected", async () => {
    const connection = new MilkyConnection({
      url: "ws://localhost:3000",
      logger: mockLogger,
      onEvent: onEventMock,
    });

    await expect(connection.sendRequest("test_action", {})).rejects.toThrow(
      "WebSocket not connected",
    );
  });

  test("should emit events on EventEmitter", () => {
    const connection = new MilkyConnection({
      url: "ws://localhost:3000",
      logger: mockLogger,
      onEvent: onEventMock,
    });

    const connectHandler = mock(() => {});
    const disconnectHandler = mock(() => {});

    connection.on("connect", connectHandler);
    connection.on("disconnect", disconnectHandler);

    // Manually emit events for testing
    connection.emit("connect");
    connection.emit("disconnect");

    expect(connectHandler).toHaveBeenCalledTimes(1);
    expect(disconnectHandler).toHaveBeenCalledTimes(1);
  });

  test("disconnect should set connected to false", async () => {
    const connection = new MilkyConnection({
      url: "ws://localhost:3000",
      logger: mockLogger,
      onEvent: onEventMock,
    });

    await connection.disconnect();
    expect(connection.isConnected()).toBe(false);
  });
});
