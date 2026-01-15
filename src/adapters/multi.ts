import type { Logger } from "pino";

import type {
  Bot,
  MessageHandler,
  PlatformAdapter,
  SendMessageOptions,
  SessionEvent,
} from "../types/platform";
import { logger as defaultLogger } from "../logger";

interface AdapterEntry {
  adapter: PlatformAdapter;
  bot: Bot;
}

interface MultiAdapterOptions {
  adapters: PlatformAdapter[];
  logger?: Logger;
}

/**
 * Wrap multiple platform adapters and route send/receive by platform.
 */
export class MultiAdapter implements PlatformAdapter {
  readonly platform = "multi";

  private readonly entries: Map<string, AdapterEntry>;
  private readonly logger: Logger;

  constructor(options: MultiAdapterOptions) {
    this.logger = options.logger ?? defaultLogger.child({ adapter: "multi" });
    this.entries = new Map(
      options.adapters.map((adapter) => [
        adapter.platform,
        {
          adapter,
          bot: createBot(adapter),
        },
      ]),
    );
  }

  async connect(bot: Bot): Promise<void> {
    bot.status = "connected";
    await Promise.all(
      Array.from(this.entries.values()).map(async (entry) =>
        entry.adapter.connect(entry.bot),
      ),
    );
  }

  async disconnect(bot: Bot): Promise<void> {
    bot.status = "disconnected";
    await Promise.allSettled(
      Array.from(this.entries.values()).map(async (entry) =>
        entry.adapter.disconnect(entry.bot),
      ),
    );
  }

  onEvent(handler: MessageHandler): void {
    for (const entry of this.entries.values()) {
      entry.adapter.onEvent(handler);
    }
  }

  async sendMessage(
    session: SessionEvent,
    content: string,
    options?: SendMessageOptions,
  ): Promise<void> {
    const platformKey = session.platform?.toLowerCase();
    const entry = platformKey ? this.entries.get(platformKey) : null;
    if (!entry) {
      this.logger.warn(
        { platform: session.platform, messageId: session.messageId },
        "No adapter found for platform",
      );
      return;
    }
    await entry.adapter.sendMessage(session, content, options);
  }

  getBotUserId(): string | null {
    return null;
  }
}

function createBot(adapter: PlatformAdapter): Bot {
  return {
    platform: adapter.platform,
    selfId: "",
    status: "disconnected",
    capabilities: {
      canEditMessage: false,
      canDeleteMessage: false,
      canSendRichContent: false,
    },
    adapter,
  };
}
