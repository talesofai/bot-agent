import type { Logger } from "pino";

import type {
  Bot,
  MessageHandler,
  PlatformAdapter,
  SendMessageOptions,
  SessionEvent,
} from "../../types/platform";
import { logger as defaultLogger } from "../../logger";
import {
  LlbotRegistry,
  type LlbotRegistryEntry,
} from "../../registry/llbot-registry";
import { QQAdapter } from "./adapter";
import type { BotMessageStore } from "../../store/bot-message-store";

interface QQAdapterPoolOptions {
  redisUrl: string;
  registryPrefix: string;
  logger?: Logger;
  botMessageStore?: BotMessageStore;
}

interface BotConnection {
  adapter: QQAdapter;
  bot: Bot;
  wsUrl: string;
}

export class QQAdapterPool implements PlatformAdapter {
  readonly platform = "qq";

  private registry: LlbotRegistry;
  private logger: Logger;
  private handlers: MessageHandler[] = [];
  private connections = new Map<string, BotConnection>();
  private connecting = new Set<string>();
  private botMessageStore?: BotMessageStore;

  constructor(options: QQAdapterPoolOptions) {
    this.logger = (options.logger ?? defaultLogger).child({
      adapter: "qq-pool",
    });
    this.registry = new LlbotRegistry({
      redisUrl: options.redisUrl,
      prefix: options.registryPrefix,
      logger: this.logger,
    });
    this.botMessageStore = options.botMessageStore;
  }

  async connect(bot: Bot): Promise<void> {
    bot.status = "connected";
    await this.registry.start(async (entries) => {
      await this.applyRegistry(entries);
    });
  }

  async disconnect(bot: Bot): Promise<void> {
    bot.status = "disconnected";
    await this.registry.stop();
    await this.disconnectAll();
  }

  onEvent(handler: MessageHandler): void {
    this.handlers.push(handler);
    for (const connection of this.connections.values()) {
      connection.adapter.onEvent(handler);
    }
  }

  async sendMessage(
    session: SessionEvent,
    content: string,
    options?: SendMessageOptions,
  ): Promise<void> {
    const botId = session.selfId;
    if (!botId) {
      this.logger.warn(
        { sessionId: session.messageId },
        "Missing selfId for response routing",
      );
      return;
    }
    const connection = this.connections.get(botId);
    if (!connection) {
      this.logger.warn(
        { botId, sessionId: session.messageId },
        "No adapter connection for botId",
      );
      return;
    }
    await connection.adapter.sendMessage(session, content, options);
  }

  getBotUserId(): string | null {
    return null;
  }

  private async applyRegistry(
    entries: Map<string, LlbotRegistryEntry>,
  ): Promise<void> {
    const activeBotIds = new Set<string>();
    for (const entry of entries.values()) {
      if (entry.platform !== "qq") {
        continue;
      }
      activeBotIds.add(entry.botId);
      const existing = this.connections.get(entry.botId);
      if (existing && existing.wsUrl === entry.wsUrl) {
        continue;
      }
      if (existing) {
        await this.disconnectBot(entry.botId);
      }
      await this.connectBot(entry);
    }

    for (const botId of this.connections.keys()) {
      if (!activeBotIds.has(botId)) {
        await this.disconnectBot(botId);
      }
    }
  }

  private async connectBot(entry: LlbotRegistryEntry): Promise<void> {
    if (this.connecting.has(entry.botId)) {
      return;
    }
    this.connecting.add(entry.botId);
    const adapter = new QQAdapter({
      url: entry.wsUrl,
      logger: this.logger,
      botMessageStore: this.botMessageStore,
    });
    const bot: Bot = {
      platform: this.platform,
      selfId: entry.botId,
      status: "disconnected",
      capabilities: {
        canEditMessage: false,
        canDeleteMessage: false,
        canSendRichContent: false,
      },
      adapter,
    };
    for (const handler of this.handlers) {
      adapter.onEvent(handler);
    }
    try {
      await adapter.connect(bot);
      this.connections.set(entry.botId, {
        adapter,
        bot,
        wsUrl: entry.wsUrl,
      });
      this.logger.info(
        { botId: entry.botId, wsUrl: entry.wsUrl },
        "Connected to llbot",
      );
    } catch (err) {
      this.logger.error(
        { err, botId: entry.botId, wsUrl: entry.wsUrl },
        "Failed to connect to llbot",
      );
    } finally {
      this.connecting.delete(entry.botId);
    }
  }

  private async disconnectBot(botId: string): Promise<void> {
    const existing = this.connections.get(botId);
    if (!existing) {
      return;
    }
    try {
      await existing.adapter.disconnect(existing.bot);
    } catch (err) {
      this.logger.warn({ err, botId }, "Failed to disconnect llbot");
    } finally {
      this.connections.delete(botId);
    }
  }

  private async disconnectAll(): Promise<void> {
    const disconnects = Array.from(this.connections.keys()).map((botId) =>
      this.disconnectBot(botId),
    );
    await Promise.allSettled(disconnects);
  }
}
