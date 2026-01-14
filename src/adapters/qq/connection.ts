import type { Logger } from "pino";
import { EventEmitter } from "node:events";

export interface MilkyConnectionOptions {
  url: string;
  logger: Logger;
  onEvent: (event: unknown) => Promise<void>;
  onBotId?: (id: string) => void;
}

interface ReconnectConfig {
  initialDelay: number;
  maxDelay: number;
  multiplier: number;
}

const DEFAULT_RECONNECT: ReconnectConfig = {
  initialDelay: 5000,
  maxDelay: 60000,
  multiplier: 2,
};
const CONNECT_TIMEOUT_MS = 15000;

export class MilkyConnection extends EventEmitter {
  private ws: WebSocket | null = null;
  private url: string;
  private logger: Logger;
  private onEvent: (event: unknown) => Promise<void>;
  private onBotId?: (id: string) => void;

  private connected = false;
  private shouldReconnect = true;
  private reconnectAttempt = 0;
  private reconnectConfig: ReconnectConfig;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private connectPromise: Promise<void> | null = null;
  private readonly textDecoder = new TextDecoder();

  private responseCallbacks = new Map<
    string,
    {
      resolve: (data: unknown) => void;
      reject: (err: Error) => void;
      timeout: ReturnType<typeof setTimeout>;
    }
  >();
  private echoCounter = 0;

  constructor(options: MilkyConnectionOptions) {
    super();
    this.url = options.url;
    this.logger = options.logger.child({ component: "connection" });
    this.onEvent = options.onEvent;
    this.onBotId = options.onBotId;
    this.reconnectConfig = DEFAULT_RECONNECT;
  }

  async connect(): Promise<void> {
    this.shouldReconnect = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.connected) {
      return;
    }
    if (this.connectPromise) {
      return this.connectPromise;
    }
    this.connectPromise = this.waitForConnect();
    this.openSocket();
    try {
      await this.connectPromise;
    } finally {
      this.connectPromise = null;
    }
  }

  async disconnect(): Promise<void> {
    this.shouldReconnect = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.closeSocket();
    }
    if (this.connectPromise) {
      this.emit("connect_error", new Error("WebSocket disconnected"));
    }
    this.connected = false;
    this.cancelPendingRequests();
  }

  isConnected(): boolean {
    return this.connected;
  }

  async sendRequest(
    action: string,
    params: Record<string, unknown> = {},
  ): Promise<unknown> {
    if (!this.ws || !this.connected) {
      throw new Error("WebSocket not connected");
    }

    this.echoCounter = this.nextEchoCounter();
    const echo = String(this.echoCounter);
    const payload = JSON.stringify({ action, params, echo });

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        const callback = this.responseCallbacks.get(echo);
        if (callback) {
          this.responseCallbacks.delete(echo);
          callback.reject(new Error(`Request timeout for action: ${action}`));
        }
      }, 30000);

      this.responseCallbacks.set(echo, {
        resolve: (data) => {
          clearTimeout(timeout);
          resolve(data);
        },
        reject: (err) => {
          clearTimeout(timeout);
          reject(err);
        },
        timeout,
      });

      try {
        this.ws!.send(payload);
        this.logger.debug({ action, echo }, "Request sent");
      } catch (err) {
        this.responseCallbacks.delete(echo);
        clearTimeout(timeout);
        const error =
          err instanceof Error ? err : new Error("WebSocket send failed");
        reject(error);
      }
    });
  }

  private handleMessageEvent = (event: MessageEvent): void => {
    void this.handleMessage(event.data);
  };

  private nextEchoCounter(): number {
    return this.echoCounter + 1;
  }

  private async handleMessage(data: unknown): Promise<void> {
    try {
      const normalized = await this.normalizeMessageData(data);
      if (!normalized) {
        this.logger.warn({ data }, "Unsupported message payload");
        return;
      }
      const parsed = JSON.parse(normalized);
      this.logger.debug({ data: parsed }, "Message received");
      if (!parsed || typeof parsed !== "object") {
        this.logger.warn({ data: parsed }, "Unexpected message payload");
        return;
      }
      const payload = parsed as Record<string, unknown>;

      // Handle response messages
      if ("status" in payload && "echo" in payload) {
        const echo = String(payload.echo);
        const callback = this.responseCallbacks.get(echo);
        if (callback) {
          this.responseCallbacks.delete(echo);
          if (payload.status === "ok") {
            callback.resolve(payload.data);
          } else {
            const message =
              typeof payload.message === "string"
                ? payload.message
                : "Request failed";
            callback.reject(new Error(message));
          }
        }
        return;
      }

      // Handle events
      if ("post_type" in payload) {
        // Extract bot ID from lifecycle events
        if (
          payload.post_type === "meta_event" &&
          payload.meta_event_type === "lifecycle" &&
          payload.self_id
        ) {
          this.onBotId?.(String(payload.self_id));
        }

        // Process message events
        this.onEvent(payload).catch((err) => {
          this.logger.error({ err }, "Event handler error");
        });
      }
    } catch (err) {
      this.logger.error({ err, data }, "Failed to parse message");
    }
  }

  private async normalizeMessageData(data: unknown): Promise<string | null> {
    if (typeof data === "string") {
      return data;
    }
    if (data instanceof ArrayBuffer) {
      return this.textDecoder.decode(new Uint8Array(data));
    }
    if (ArrayBuffer.isView(data)) {
      return this.textDecoder.decode(
        new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
      );
    }
    if (data instanceof Blob) {
      return await data.text();
    }
    return null;
  }

  private handleOpen = (): void => {
    this.connected = true;
    this.reconnectAttempt = 0;
    this.logger.info("WebSocket connected");
    this.emit("connect");
  };

  private handleError = (event: Event): void => {
    const err = new Error(`WebSocket error: ${event.type}`);
    this.logger.error({ err }, "WebSocket error");
    if (!this.connected) {
      this.emit("connect_error", err);
    }
    this.ws?.close();
  };

  private handleClose = (): void => {
    const wasConnected = this.connected;
    this.connected = false;
    this.detachSocket();
    this.cancelPendingRequests();

    if (wasConnected) {
      this.logger.warn("WebSocket closed");
      this.emit("disconnect");
    } else {
      const err = new Error("WebSocket closed before connection established");
      this.logger.error({ err }, "Connection failed");
      this.emit("connect_error", err);
    }

    this.scheduleReconnect();
  };

  private openSocket(): void {
    if (this.connected) {
      return;
    }
    if (this.ws) {
      this.logger.warn("Existing WebSocket detected, closing before reconnect");
      this.closeSocket();
    }

    const WebSocketImpl = globalThis.WebSocket;
    if (!WebSocketImpl) {
      const err = new Error(
        "WebSocket is not available. This adapter requires Bun runtime.",
      );
      this.logger.error({ err }, "WebSocket unavailable");
      this.emit("connect_error", err);
      return;
    }

    this.logger.debug({ url: this.url }, "Opening WebSocket connection");

    this.ws = new WebSocketImpl(this.url);
    this.ws.addEventListener("open", this.handleOpen);
    this.ws.addEventListener("error", this.handleError);
    this.ws.addEventListener("close", this.handleClose);
    this.ws.addEventListener("message", this.handleMessageEvent);
  }

  private waitForConnect(): Promise<void> {
    if (this.connected) {
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        cleanup();
        try {
          this.ws?.close();
        } catch {
          // Best-effort cleanup after timeout.
        }
        reject(new Error("WebSocket connection timed out"));
      }, CONNECT_TIMEOUT_MS);
      const onConnect = () => {
        cleanup();
        resolve();
      };
      const onError = (err: Error) => {
        cleanup();
        reject(err);
      };
      const cleanup = () => {
        clearTimeout(timeout);
        this.off("connect", onConnect);
        this.off("connect_error", onError);
      };
      this.on("connect", onConnect);
      this.on("connect_error", onError);
    });
  }

  private detachSocket(): void {
    if (!this.ws) {
      return;
    }
    this.ws.removeEventListener("open", this.handleOpen);
    this.ws.removeEventListener("error", this.handleError);
    this.ws.removeEventListener("close", this.handleClose);
    this.ws.removeEventListener("message", this.handleMessageEvent);
    this.ws = null;
  }

  private closeSocket(): void {
    if (!this.ws) {
      return;
    }
    const socket = this.ws;
    this.detachSocket();
    try {
      socket.close();
    } catch {
      // Best-effort shutdown
    }
  }

  private scheduleReconnect(): void {
    if (!this.shouldReconnect) {
      return;
    }

    if (this.reconnectTimer) {
      return;
    }

    const delay = Math.min(
      this.reconnectConfig.initialDelay *
        Math.pow(this.reconnectConfig.multiplier, this.reconnectAttempt),
      this.reconnectConfig.maxDelay,
    );

    this.reconnectAttempt++;
    this.logger.info(
      { delay, attempt: this.reconnectAttempt },
      "Scheduling reconnect",
    );

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.openSocket();
    }, delay);
  }

  private cancelPendingRequests(): void {
    for (const [echo, callback] of this.responseCallbacks) {
      clearTimeout(callback.timeout);
      callback.reject(new Error("Connection closed"));
      this.responseCallbacks.delete(echo);
    }
  }
}
