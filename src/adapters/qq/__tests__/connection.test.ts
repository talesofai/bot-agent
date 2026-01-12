import { describe, expect, test, mock, beforeEach, afterEach } from "bun:test";
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

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  private listeners = new Map<string, Set<(event: Event) => void>>();
  readonly url: string;

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  addEventListener(type: string, handler: (event: Event) => void): void {
    const set = this.listeners.get(type) ?? new Set();
    set.add(handler);
    this.listeners.set(type, set);
  }

  removeEventListener(type: string, handler: (event: Event) => void): void {
    const set = this.listeners.get(type);
    if (!set) {
      return;
    }
    set.delete(handler);
  }

  send(): void {}

  close(): void {
    this.emit("close");
  }

  emit(type: string): void {
    const set = this.listeners.get(type);
    if (!set) {
      return;
    }
    const event = { type } as Event;
    for (const handler of set) {
      handler(event);
    }
  }
}

describe("MilkyConnection", () => {
  let mockLogger: Logger;
  let onEventMock: ReturnType<typeof mock>;
  let onBotIdMock: ReturnType<typeof mock>;
  let originalWebSocket: typeof WebSocket;

  beforeEach(() => {
    mockLogger = createMockLogger();
    onEventMock = mock(async () => {});
    onBotIdMock = mock(() => {});
    originalWebSocket = globalThis.WebSocket;
    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
    FakeWebSocket.instances = [];
  });

  afterEach(() => {
    globalThis.WebSocket = originalWebSocket;
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

  test("should reconnect after close", async () => {
    const connection = new MilkyConnection({
      url: "ws://localhost:3000",
      logger: mockLogger,
      onEvent: onEventMock,
    });
    (connection as unknown as { reconnectConfig: { initialDelay: number; maxDelay: number; multiplier: number } })
      .reconnectConfig = { initialDelay: 1, maxDelay: 1, multiplier: 1 };

    const connectPromise = connection.connect();
    FakeWebSocket.instances[0].emit("open");
    await connectPromise;

    FakeWebSocket.instances[0].emit("close");

    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(FakeWebSocket.instances.length).toBe(2);
  });

  test("should handle ArrayBuffer payloads", async () => {
    const connection = new MilkyConnection({
      url: "ws://localhost:3000",
      logger: mockLogger,
      onEvent: onEventMock,
    });

    const payload = JSON.stringify({ post_type: "message" });
    const buffer = new TextEncoder().encode(payload).buffer;

    await (connection as unknown as { handleMessage: (data: unknown) => Promise<void> }).handleMessage(
      buffer
    );

    expect(onEventMock).toHaveBeenCalledTimes(1);
  });

  test("should handle Uint8Array payloads", async () => {
    const connection = new MilkyConnection({
      url: "ws://localhost:3000",
      logger: mockLogger,
      onEvent: onEventMock,
    });

    const payload = JSON.stringify({ post_type: "message" });
    const buffer = new TextEncoder().encode(payload);

    await (connection as unknown as { handleMessage: (data: unknown) => Promise<void> }).handleMessage(
      buffer
    );

    expect(onEventMock).toHaveBeenCalledTimes(1);
  });
});
