import { EventEmitter } from "node:events";
import type { Logger } from "pino";
import type {
  PlatformAdapter,
  MessageHandler,
  SendMessageOptions,
} from "../../types/platform";
import { MilkyConnection } from "./connection";
import { parseMessage } from "./parser";
import { MessageSender } from "./sender";
import { logger as defaultLogger } from "../../logger";

export interface QQAdapterOptions {
  /** Milky WebSocket URL */
  url?: string;
  /** Custom logger instance */
  logger?: Logger;
}

export class QQAdapter extends EventEmitter implements PlatformAdapter {
  readonly platform = "qq";

  private connection: MilkyConnection;
  private sender: MessageSender;
  private logger: Logger;
  private botUserId: string | null = null;
  private isShuttingDown = false;

  constructor(options: QQAdapterOptions = {}) {
    const url = options.url;
    if (!url) {
      throw new Error(
        "QQAdapter requires MILKY_URL to be configured (received empty or undefined url)",
      );
    }
    super();
    this.logger = options.logger ?? defaultLogger.child({ adapter: "qq" });

    this.connection = new MilkyConnection({
      url,
      logger: this.logger,
      onEvent: this.handleEvent.bind(this),
      onBotId: (id: string) => {
        this.botUserId = id;
        this.logger.info({ botId: id }, "Bot ID received");
      },
    });

    // Forward connection events with error protection
    this.connection.on("connect", () => {
      this.emit("connect");
    });
    this.connection.on("disconnect", () => {
      // Don't notify if we're intentionally shutting down
      if (this.isShuttingDown) {
        return;
      }
      this.emit("disconnect");
    });

    this.sender = new MessageSender(this.connection, this.logger);
  }

  async connect(): Promise<void> {
    this.isShuttingDown = false; // Reset in case of reconnection after previous disconnect
    this.logger.info("Connecting to Milky server...");
    await this.connection.connect();
    this.logger.info("Connected to Milky server");
  }

  async disconnect(): Promise<void> {
    this.isShuttingDown = true;
    this.logger.info("Disconnecting from Milky server...");
    await this.connection.disconnect();
    this.logger.info("Disconnected from Milky server");
  }

  onMessage(handler: MessageHandler): void {
    this.on("message", handler);
  }

  async sendMessage(options: SendMessageOptions): Promise<void> {
    await this.sender.send(options);
  }

  getBotUserId(): string | null {
    return this.botUserId;
  }

  /** Register a handler called when connection is established (including reconnects) */
  onConnect(handler: () => void): void {
    this.on("connect", handler);
  }

  /** Register a handler called when connection is lost */
  onDisconnect(handler: () => void): void {
    this.on("disconnect", handler);
  }

  private async handleEvent(event: unknown): Promise<void> {
    try {
      const message = parseMessage(event, this.botUserId);
      if (message) {
        this.logger.debug({ messageId: message.id }, "Message received");
        await this.emitMessage(message);
      }
    } catch (err) {
      this.logger.error({ err, event }, "Failed to parse event");
    }
  }

  private async emitMessage(
    message: Parameters<MessageHandler>[0],
  ): Promise<void> {
    const handlers = this.listeners("message") as MessageHandler[];
    for (const handler of handlers) {
      try {
        await handler(message);
      } catch (err) {
        this.logger.error({ err, messageId: message.id }, "Handler error");
      }
    }
  }
}
