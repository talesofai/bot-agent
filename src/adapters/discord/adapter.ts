import { EventEmitter } from "node:events";
import type { Logger } from "pino";
import {
  Client,
  GatewayIntentBits,
  Partials,
  REST,
  Routes,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type Interaction,
  type Message,
} from "discord.js";
import type {
  Bot,
  MessageHandler,
  PlatformAdapter,
  SendMessageOptions,
  SessionElement,
  SessionEvent,
} from "../../types/platform";
import { logger as defaultLogger } from "../../logger";
import { parseMessage } from "./parser";
import { MessageSender } from "./sender";

export interface DiscordAdapterOptions {
  token?: string;
  logger?: Logger;
}

export interface DiscordInteractionExtras {
  interactionId: string;
  commandName: string;
  channelId: string;
  guildId?: string;
  userId: string;
}

export class DiscordAdapter extends EventEmitter implements PlatformAdapter {
  readonly platform = "discord";

  private token: string;
  private logger: Logger;
  private client: Client;
  private sender: MessageSender;
  private botUserId: string | null = null;
  private bot: Bot | null = null;
  private slashCommandsEnabled = false;

  constructor(options: DiscordAdapterOptions = {}) {
    const token = options.token;
    if (!token) {
      throw new Error("DiscordAdapter requires DISCORD_TOKEN");
    }
    super();
    this.token = token;
    this.logger = options.logger ?? defaultLogger.child({ adapter: "discord" });
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages,
      ],
      partials: [Partials.Channel],
    });
    this.sender = new MessageSender(this.client, this.logger);

    this.client.on("ready", () => {
      const user = this.client.user;
      if (!user) {
        return;
      }
      this.botUserId = user.id;
      if (this.bot) {
        this.bot.selfId = user.id;
        this.bot.status = "connected";
      }
      this.logger.info({ botId: user.id }, "Discord client ready");
      this.emit("connect");
    });

    this.client.on("messageCreate", (message) => {
      void this.handleMessage(message);
    });

    this.client.on("error", (err) => {
      this.logger.error({ err }, "Discord client error");
    });
  }

  enableSlashCommands(): void {
    if (this.slashCommandsEnabled) {
      return;
    }
    this.slashCommandsEnabled = true;

    this.client.on("interactionCreate", (interaction) => {
      void this.handleInteraction(interaction);
    });

    this.client.once("ready", () => {
      void this.registerSlashCommands();
    });
  }

  async connect(bot: Bot): Promise<void> {
    this.bot = bot;
    this.logger.info("Connecting to Discord...");
    await this.client.login(this.token);
  }

  async disconnect(bot: Bot): Promise<void> {
    bot.status = "disconnected";
    this.logger.info("Disconnecting from Discord...");
    await this.client.destroy();
    this.logger.info("Disconnected from Discord");
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

  async sendTyping(session: SessionEvent): Promise<void> {
    await this.sender.sendTyping(session);
  }

  getBotUserId(): string | null {
    return this.botUserId;
  }

  private async handleMessage(message: Message): Promise<void> {
    if (this.listenerCount("event") === 0) {
      return;
    }
    try {
      const parsed = parseMessage(message, this.botUserId ?? undefined);
      if (!parsed) {
        return;
      }
      this.logger.debug({ messageId: parsed.messageId }, "Message received");
      await this.emitEvent(parsed);
    } catch (err) {
      this.logger.error({ err }, "Failed to handle Discord message");
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

  private async handleInteraction(interaction: Interaction): Promise<void> {
    if (!interaction.isChatInputCommand()) {
      return;
    }

    const commandName = interaction.commandName;
    if (commandName === "ping") {
      await safeReply(interaction, "pong", { ephemeral: true });
      return;
    }
    if (commandName === "help") {
      await safeReply(
        interaction,
        "可用指令：\n- /ask text:<内容> [key:<会话槽位>]\n- /ping\n- /help",
        { ephemeral: true },
      );
      return;
    }
    if (commandName !== "ask") {
      await safeReply(interaction, `未知指令：/${commandName}`, {
        ephemeral: true,
      });
      return;
    }

    const channelId = interaction.channelId;
    if (!channelId) {
      await safeReply(interaction, "缺少 channelId，无法处理该指令。", {
        ephemeral: true,
      });
      return;
    }

    const botId = this.botUserId ?? this.client.user?.id ?? "";
    if (!botId) {
      await safeReply(interaction, "Bot 尚未就绪，请稍后重试。", {
        ephemeral: true,
      });
      return;
    }

    const text = interaction.options.getString("text", true).trim();
    if (!text) {
      await safeReply(interaction, "请输入 text 参数。", { ephemeral: true });
      return;
    }
    const key = interaction.options.getInteger("key");
    const content = key !== null ? `#${key} ${text}` : text;

    await safeReply(interaction, "收到，正在处理…", { ephemeral: true });

    if (this.listenerCount("event") === 0) {
      return;
    }

    const elements: SessionElement[] = [
      { type: "mention", userId: botId },
      { type: "text", text: content },
    ];

    const event: SessionEvent<DiscordInteractionExtras> = {
      type: "message",
      platform: "discord",
      selfId: botId,
      userId: interaction.user.id,
      guildId: interaction.guildId ?? undefined,
      channelId,
      messageId: interaction.id,
      content,
      elements,
      timestamp: Date.now(),
      extras: {
        interactionId: interaction.id,
        commandName,
        channelId,
        guildId: interaction.guildId ?? undefined,
        userId: interaction.user.id,
      },
    };

    await this.emitEvent(event);
  }

  private async registerSlashCommands(): Promise<void> {
    const botId = this.client.user?.id;
    if (!botId) {
      return;
    }

    const commands = buildSlashCommands();
    const rest = new REST({ version: "10" }).setToken(this.token);

    const guildIds = this.client.guilds.cache.map((guild) => guild.id);
    if (guildIds.length === 0) {
      try {
        await rest.put(Routes.applicationCommands(botId), {
          body: commands,
        });
        this.logger.info({ botId }, "Registered global slash commands");
      } catch (err) {
        this.logger.warn({ err, botId }, "Failed to register global commands");
      }
      return;
    }

    await Promise.allSettled(
      guildIds.map(async (guildId) => {
        try {
          await rest.put(Routes.applicationGuildCommands(botId, guildId), {
            body: commands,
          });
          this.logger.info(
            { botId, guildId },
            "Registered guild slash commands",
          );
        } catch (err) {
          this.logger.warn(
            { err, botId, guildId },
            "Failed to register guild commands",
          );
        }
      }),
    );
  }
}

function buildSlashCommands() {
  return [
    new SlashCommandBuilder()
      .setName("ask")
      .setDescription("向机器人提问（走同一套会话/队列）")
      .addStringOption((option) =>
        option.setName("text").setDescription("问题内容").setRequired(true),
      )
      .addIntegerOption((option) =>
        option
          .setName("key")
          .setDescription("会话槽位（默认 0）")
          .setMinValue(0)
          .setRequired(false),
      )
      .toJSON(),
    new SlashCommandBuilder()
      .setName("ping")
      .setDescription("健康检查")
      .toJSON(),
    new SlashCommandBuilder()
      .setName("help")
      .setDescription("查看可用指令")
      .toJSON(),
  ];
}

async function safeReply(
  interaction: ChatInputCommandInteraction,
  content: string,
  options: { ephemeral: boolean },
): Promise<void> {
  try {
    if (interaction.replied || interaction.deferred) {
      await interaction.followUp({ content, ephemeral: options.ephemeral });
      return;
    }
    await interaction.reply({ content, ephemeral: options.ephemeral });
  } catch {
    // ignore
  }
}
