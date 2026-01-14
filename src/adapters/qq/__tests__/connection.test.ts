import { describe, expect, test, mock, beforeEach, afterEach } from "bun:test";
import { Server, WebSocket as MockWebSocket } from "mock-socket";
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
  let originalWebSocket: typeof WebSocket;
  let server: Server;
  let connectionCount = 0;
  let sockets: Array<{ close: () => void }> = [];
  const wsUrl = "ws://localhost:1234";

  beforeEach(() => {
    mockLogger = createMockLogger();
    onEventMock = mock(async () => {});
    onBotIdMock = mock(() => {});
    originalWebSocket = globalThis.WebSocket;
    globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket;
    connectionCount = 0;
    sockets = [];
    server = new Server(wsUrl);
    server.on("connection", (socket) => {
      connectionCount += 1;
      sockets.push(socket);
    });
  });

  afterEach(() => {
    globalThis.WebSocket = originalWebSocket;
    server.stop();
  });

  test("should create connection instance correctly", () => {
    const connection = new MilkyConnection({
      url: wsUrl,
      logger: mockLogger,
      onEvent: onEventMock,
      onBotId: onBotIdMock,
    });

    expect(connection).toBeDefined();
    expect(connection.isConnected()).toBe(false);
  });

  test("should report not connected initially", () => {
    const connection = new MilkyConnection({
      url: wsUrl,
      logger: mockLogger,
      onEvent: onEventMock,
    });

    expect(connection.isConnected()).toBe(false);
  });

  test("should throw error when sending request while disconnected", async () => {
    const connection = new MilkyConnection({
      url: wsUrl,
      logger: mockLogger,
      onEvent: onEventMock,
    });

    await expect(connection.sendRequest("test_action", {})).rejects.toThrow(
      "WebSocket not connected",
    );
  });

  test("should resolve sendRequest when echo is numeric", async () => {
    server.on("connection", (socket) => {
      socket.on("message", (data) => {
        const payload = JSON.parse(String(data)) as { echo?: string };
        socket.send(
          JSON.stringify({
            status: "ok",
            echo: payload.echo ? Number(payload.echo) : 0,
            data: { ok: true },
          }),
        );
      });
    });

    const connection = new MilkyConnection({
      url: wsUrl,
      logger: mockLogger,
      onEvent: onEventMock,
    });

    await connection.connect();
    const response = await connection.sendRequest("test_action", {
      foo: "bar",
    });
    expect(response).toEqual({ ok: true });
    await connection.disconnect();
  });

  test("should emit events on EventEmitter", () => {
    const connection = new MilkyConnection({
      url: wsUrl,
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
      url: wsUrl,
      logger: mockLogger,
      onEvent: onEventMock,
    });

    await connection.disconnect();
    expect(connection.isConnected()).toBe(false);
  });

  test("should reconnect after close", async () => {
    const connection = new MilkyConnection({
      url: wsUrl,
      logger: mockLogger,
      onEvent: onEventMock,
    });
    (
      connection as unknown as {
        reconnectConfig: {
          initialDelay: number;
          maxDelay: number;
          multiplier: number;
        };
      }
    ).reconnectConfig = { initialDelay: 1, maxDelay: 1, multiplier: 1 };

    const connectPromise = connection.connect();
    await new Promise((resolve) => setTimeout(resolve, 10));
    await connectPromise;

    sockets[0]?.close();

    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(connectionCount).toBe(2);
  });

  test("should handle ArrayBuffer payloads", async () => {
    const connection = new MilkyConnection({
      url: wsUrl,
      logger: mockLogger,
      onEvent: onEventMock,
    });

    const payload = JSON.stringify({ post_type: "message" });
    const buffer = new TextEncoder().encode(payload).buffer;

    await (
      connection as unknown as {
        handleMessage: (data: unknown) => Promise<void>;
      }
    ).handleMessage(buffer);

    expect(onEventMock).toHaveBeenCalledTimes(1);
  });

  test("should handle Uint8Array payloads", async () => {
    const connection = new MilkyConnection({
      url: wsUrl,
      logger: mockLogger,
      onEvent: onEventMock,
    });

    const payload = JSON.stringify({ post_type: "message" });
    const buffer = new TextEncoder().encode(payload);

    await (
      connection as unknown as {
        handleMessage: (data: unknown) => Promise<void>;
      }
    ).handleMessage(buffer);

    expect(onEventMock).toHaveBeenCalledTimes(1);
  });
});
