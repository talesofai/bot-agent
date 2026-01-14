import { EventEmitter } from "node:events";
import type { Logger } from "pino";
import type {
  Bot,
  PlatformAdapter,
  MessageHandler,
  SendMessageOptions,
  SessionEvent,
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
  private bot: Bot | null = null;
  private isShuttingDown = false;

  constructor(options: QQAdapterOptions = {}) {
    const url = options.url;
    if (!url) {
      throw new Error(
        "QQAdapter requires a Milky WebSocket URL (received empty or undefined url)",
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
        if (this.bot) {
          this.bot.selfId = id;
          this.bot.status = "connected";
        }
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

  async connect(bot: Bot): Promise<void> {
    this.bot = bot;
    this.isShuttingDown = false; // Reset in case of reconnection after previous disconnect
    this.logger.info("Connecting to Milky server...");
    await this.connection.connect();
    bot.status = "connected";
    this.logger.info("Connected to Milky server");
  }

  async disconnect(bot: Bot): Promise<void> {
    this.isShuttingDown = true;
    bot.status = "disconnected";
    this.logger.info("Disconnecting from Milky server...");
    await this.connection.disconnect();
    this.logger.info("Disconnected from Milky server");
  }

  onEvent(handler: MessageHandler): void {
    this.on("event", handler);
  }

  async sendMessage(
    session: SessionEvent,
    content: string,
    options?: SendMessageOptions,
  ): Promise<void> {
    await this.sender.send(session, content, options);
  }

  getBotUserId(): string | null {
    return this.botUserId;
  }

  private async handleEvent(event: unknown): Promise<void> {
    try {
      const message = parseMessage(event);
      if (message) {
        this.logger.debug({ messageId: message.messageId }, "Message received");
        await this.emitEvent(message);
      }
    } catch (err) {
      this.logger.error({ err, event }, "Failed to parse event");
    }
  }

  private async emitEvent(
    message: Parameters<MessageHandler>[0],
  ): Promise<void> {
    const handlers = this.listeners("event") as MessageHandler[];
    for (const handler of handlers) {
      try {
        await handler(message);
      } catch (err) {
        this.logger.error(
          { err, messageId: message.messageId },
          "Handler error",
        );
      }
    }
  }
}
