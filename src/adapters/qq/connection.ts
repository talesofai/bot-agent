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

  private responseCallbacks = new Map<
    string,
    { resolve: (data: unknown) => void; reject: (err: Error) => void }
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
    return this.doConnect();
  }

  private async doConnect(): Promise<void> {
    return new Promise((resolve, reject) => {
      let resolved = false;

      const cleanup = () => {
        this.ws?.removeEventListener("open", openHandler);
        this.ws?.removeEventListener("error", initialErrorHandler);
        this.ws?.removeEventListener("close", initialCloseHandler);
      };

      const openHandler = () => {
        resolved = true;
        cleanup();
        this.connected = true;
        this.reconnectAttempt = 0;
        this.logger.info("WebSocket connected");
        this.emit("connect");

        // Re-add runtime handlers for errors and close
        this.ws?.addEventListener("error", runtimeErrorHandler);
        this.ws?.addEventListener("close", runtimeCloseHandler);
        resolve();
      };

      const initialErrorHandler = (event: Event) => {
        const err = new Error(`WebSocket error: ${event.type}`);
        this.logger.error({ err }, "WebSocket error during connection");
        if (!resolved) {
          resolved = true;
          cleanup();
          // Schedule reconnect on error (not just on close)
          if (this.shouldReconnect) {
            this.scheduleReconnect();
          }
          reject(err);
        }
      };

      const initialCloseHandler = () => {
        if (!resolved) {
          resolved = true;
          cleanup();
          const err = new Error("WebSocket closed during connection");
          this.logger.error({ err }, "Connection failed");
          // Schedule reconnect for initial connection failure
          if (this.shouldReconnect) {
            this.scheduleReconnect();
          }
          reject(err);
        }
      };

      const runtimeErrorHandler = (event: Event) => {
        const err = new Error(`WebSocket error: ${event.type}`);
        this.logger.error({ err }, "WebSocket runtime error");
        // Error may or may not trigger close, so we mark as disconnected
        // and schedule reconnect if close doesn't happen shortly
        if (this.connected) {
          this.connected = false;
          this.emit("disconnect");
          this.cancelPendingRequests();
          this.scheduleReconnect();
        }
      };

      const runtimeCloseHandler = () => {
        // Only process if we haven't already handled via error
        if (this.connected) {
          this.connected = false;
          this.logger.warn("WebSocket closed");
          this.emit("disconnect");
          this.cancelPendingRequests();
          this.scheduleReconnect();
        }
      };

      try {
        this.logger.debug({ url: this.url }, "Opening WebSocket connection");
        this.ws = new WebSocket(this.url);

        this.ws.addEventListener("open", openHandler);
        this.ws.addEventListener("error", initialErrorHandler);
        this.ws.addEventListener("close", initialCloseHandler);
        this.ws.addEventListener("message", (event: MessageEvent) => {
          this.handleMessage(event.data);
        });
      } catch (err) {
        reject(err);
      }
    });
  }

  async disconnect(): Promise<void> {
    this.shouldReconnect = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.connected = false;
    this.cancelPendingRequests();
  }

  isConnected(): boolean {
    return this.connected;
  }

  async sendRequest(action: string, params: Record<string, unknown> = {}): Promise<unknown> {
    if (!this.ws || !this.connected) {
      throw new Error("WebSocket not connected");
    }

    const echo = `${Date.now()}-${++this.echoCounter}`;
    const payload = JSON.stringify({ action, params, echo });

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.responseCallbacks.delete(echo);
        reject(new Error(`Request timeout for action: ${action}`));
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
      });

      this.ws!.send(payload);
      this.logger.debug({ action, echo }, "Request sent");
    });
  }

  private handleMessage(data: string): void {
    try {
      const parsed = JSON.parse(data);
      this.logger.debug({ data: parsed }, "Message received");

      // Handle response messages
      if ("status" in parsed && "echo" in parsed) {
        const echo = parsed.echo as string;
        const callback = this.responseCallbacks.get(echo);
        if (callback) {
          this.responseCallbacks.delete(echo);
          if (parsed.status === "ok") {
            callback.resolve(parsed.data);
          } else {
            callback.reject(new Error(parsed.message || "Request failed"));
          }
        }
        return;
      }

      // Handle events
      if ("post_type" in parsed) {
        // Extract bot ID from lifecycle events
        if (
          parsed.post_type === "meta_event" &&
          parsed.meta_event_type === "lifecycle" &&
          parsed.self_id
        ) {
          this.onBotId?.(String(parsed.self_id));
        }

        // Process message events
        this.onEvent(parsed).catch((err) => {
          this.logger.error({ err }, "Event handler error");
        });
      }
    } catch (err) {
      this.logger.error({ err, data }, "Failed to parse message");
    }
  }

  private scheduleReconnect(): void {
    if (!this.shouldReconnect) {
      return;
    }

    const delay = Math.min(
      this.reconnectConfig.initialDelay *
        Math.pow(this.reconnectConfig.multiplier, this.reconnectAttempt),
      this.reconnectConfig.maxDelay
    );

    this.reconnectAttempt++;
    this.logger.info(
      { delay, attempt: this.reconnectAttempt },
      "Scheduling reconnect"
    );

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.doConnect().catch((err) => {
        this.logger.error({ err }, "Reconnect failed");
      });
    }, delay);
  }

  private cancelPendingRequests(): void {
    for (const [echo, callback] of this.responseCallbacks) {
      callback.reject(new Error("Connection closed"));
      this.responseCallbacks.delete(echo);
    }
  }
}
