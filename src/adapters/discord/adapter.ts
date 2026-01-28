import { EventEmitter } from "node:events";
import type { Logger } from "pino";
import {
  Client,
  ChannelType,
  GatewayIntentBits,
  Partials,
  PermissionFlagsBits,
  REST,
  Routes,
  SlashCommandBuilder,
  type Attachment,
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
import { parseMessage, type DiscordMessageExtras } from "./parser";
import { MessageSender } from "./sender";
import type { BotMessageStore } from "../../store/bot-message-store";
import {
  WorldStore,
  type CharacterVisibility,
  type WorldActiveMeta,
} from "../../world/store";
import { WorldFileStore } from "../../world/file-store";
import {
  buildWorldBuildGroupId,
  buildWorldCharacterBuildGroupId,
  buildWorldGroupId,
  parseWorldGroup,
} from "../../world/ids";
import { getConfig } from "../../config";
import { feishuLogJson } from "../../feishu/webhook";
import { GroupFileRepository } from "../../store/repository";
import { fetchDiscordTextAttachment } from "./text-attachments";
import path from "node:path";
import { writeFile, mkdir, rename } from "node:fs/promises";
import { createTraceId } from "../../telemetry";
import { redactSensitiveText } from "../../utils/redact";

export interface DiscordAdapterOptions {
  token?: string;
  applicationId?: string;
  logger?: Logger;
  botMessageStore?: BotMessageStore;
}

export interface DiscordInteractionExtras {
  interactionId: string;
  commandName: string;
  channelId: string;
  guildId?: string;
  userId: string;
  isGuildOwner?: boolean;
  isGuildAdmin?: boolean;
  traceId?: string;
  synthetic?: boolean;
}

export class DiscordAdapter extends EventEmitter implements PlatformAdapter {
  readonly platform = "discord";

  private token: string;
  private applicationId: string | null;
  private logger: Logger;
  private client: Client;
  private sender: MessageSender;
  private botUserId: string | null = null;
  private bot: Bot | null = null;
  private slashCommandsEnabled = false;
  private worldStore: WorldStore;
  private worldFiles: WorldFileStore;
  private groupRepository: GroupFileRepository;

  constructor(options: DiscordAdapterOptions = {}) {
    const token = options.token;
    if (!token) {
      throw new Error("DiscordAdapter requires DISCORD_TOKEN");
    }
    super();
    this.token = token;
    const applicationId = options.applicationId?.trim();
    this.applicationId = applicationId ? applicationId : null;
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
    this.sender = new MessageSender(
      this.client,
      this.logger,
      options.botMessageStore,
    );

    const config = getConfig();
    this.worldStore = new WorldStore({
      redisUrl: config.REDIS_URL,
      logger: this.logger,
    });
    this.worldFiles = new WorldFileStore({ logger: this.logger });
    this.groupRepository = new GroupFileRepository({
      dataDir: config.GROUPS_DATA_DIR,
      logger: this.logger,
    });

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
      void this.migrateWorldJoinChannels().catch((err) => {
        this.logger.warn({ err }, "World join channel migration failed");
      });
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
      void this.handleInteraction(interaction).catch((err) => {
        this.logger.error({ err }, "Failed to handle Discord interaction");
      });
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
    await this.worldStore.close();
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
      try {
        await this.ingestWorldBuildAttachments(message, parsed);
      } catch (err) {
        this.logger.warn({ err }, "Failed to ingest world build attachments");
      }
      this.logger.debug({ messageId: parsed.messageId }, "Message received");
      await this.emitEvent(parsed);
    } catch (err) {
      this.logger.error({ err }, "Failed to handle Discord message");
    }
  }

  private async ingestWorldBuildAttachments(
    message: Message,
    session: SessionEvent<DiscordMessageExtras>,
  ): Promise<void> {
    if (!message.guildId) {
      return;
    }
    if (!message.attachments || message.attachments.size === 0) {
      return;
    }

    const groupId = await this.worldStore.getGroupIdByChannel(
      message.channelId,
    );
    const parsed = groupId ? parseWorldGroup(groupId) : null;
    if (!parsed || parsed.kind !== "build") {
      return;
    }

    const uploaded: Array<{ filename: string; content: string }> = [];
    const rejected: string[] = [];

    for (const attachment of message.attachments.values()) {
      try {
        uploaded.push(
          await fetchDiscordTextAttachment(attachment, { logger: this.logger }),
        );
      } catch {
        rejected.push((attachment.name ?? "").trim() || "document");
      }
    }

    if (uploaded.length === 0) {
      if (rejected.length === 0) {
        return;
      }
      await this.sendMessage(
        session,
        `不支持的设定文档类型：${rejected.join(", ")}\n仅支持：txt/md/docx`,
      );
      return;
    }

    const nowIso = new Date().toISOString();
    const merged =
      uploaded.length === 1
        ? uploaded[0].content
        : uploaded
            .map((doc) =>
              [
                `# 上传文档：${doc.filename}`,
                `- 时间：${nowIso}`,
                ``,
                doc.content.trimEnd(),
                ``,
                `---`,
                ``,
              ].join("\n"),
            )
            .join("\n")
            .trimEnd();
    const filename =
      uploaded.length === 1 ? uploaded[0].filename : "uploads.md";

    await this.worldFiles.writeSourceDocument(parsed.worldId, {
      filename,
      content: merged,
    });
    for (const doc of uploaded) {
      await this.worldFiles.appendEvent(parsed.worldId, {
        type: "world_source_uploaded",
        worldId: parsed.worldId,
        guildId: message.guildId,
        userId: message.author.id,
        filename: doc.filename,
        messageId: message.id,
      });
    }
    if (rejected.length > 0) {
      await this.sendMessage(
        session,
        `已读取并写入 world/source.md（${uploaded.length} 个文档）。以下文件被忽略（类型不支持）：${rejected.join(", ")}`,
      );
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
    feishuLogJson({
      event: "discord.command.start",
      command: buildInteractionCommand(interaction),
      interactionId: interaction.id,
      userId: interaction.user.id,
      guildId: interaction.guildId ?? undefined,
      channelId: interaction.channelId,
    });
    const isGuildOwner = Boolean(
      interaction.guildId &&
      interaction.guild &&
      interaction.guild.ownerId === interaction.user.id,
    );
    const isGuildAdmin = Boolean(
      interaction.guildId &&
      (interaction.memberPermissions?.has(PermissionFlagsBits.Administrator) ||
        interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)),
    );
    if (commandName === "ping") {
      await safeReply(interaction, "pong", { ephemeral: false });
      return;
    }
    if (commandName === "help") {
      await safeReply(
        interaction,
        [
          "可用指令：",
          "- /world help",
          "- /character help",
          "- /reset [key:<会话槽位>] [user:<用户>]",
          "- /resetall [key:<会话槽位>]（管理员）",
          "- /model name:<模型 ID>",
          "- /ping",
          "- /help",
        ].join("\n"),
        { ephemeral: true },
      );
      return;
    }
    if (commandName === "world") {
      await this.handleWorldCommand(interaction, {
        isGuildOwner,
        isGuildAdmin,
      });
      return;
    }
    if (commandName === "character") {
      await this.handleCharacterCommand(interaction, {
        isGuildOwner,
        isGuildAdmin,
      });
      return;
    }
    if (commandName === "reset") {
      const channelId = interaction.channelId;
      if (!channelId) {
        await safeReply(interaction, "缺少 channelId，无法处理该指令。", {
          ephemeral: false,
        });
        return;
      }
      const botId = this.botUserId ?? this.client.user?.id ?? "";
      if (!botId) {
        await safeReply(interaction, "Bot 尚未就绪，请稍后重试。", {
          ephemeral: false,
        });
        return;
      }

      const key = interaction.options.getInteger("key");
      const targetUser = interaction.options.getUser("user");
      const content = key !== null ? `#${key} /reset` : "/reset";

      await safeReply(interaction, "收到，正在重置对话…", { ephemeral: false });

      if (this.listenerCount("event") === 0) {
        return;
      }

      const elements: SessionElement[] = [{ type: "mention", userId: botId }];
      if (targetUser) {
        elements.push({ type: "mention", userId: targetUser.id });
      }
      elements.push({ type: "text", text: content });

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
          isGuildOwner: interaction.guildId ? isGuildOwner : undefined,
          isGuildAdmin: interaction.guildId ? isGuildAdmin : undefined,
        },
      };
      await this.emitEvent(event);
      return;
    }
    if (commandName === "resetall") {
      const channelId = interaction.channelId;
      if (!channelId) {
        await safeReply(interaction, "缺少 channelId，无法处理该指令。", {
          ephemeral: false,
        });
        return;
      }
      const botId = this.botUserId ?? this.client.user?.id ?? "";
      if (!botId) {
        await safeReply(interaction, "Bot 尚未就绪，请稍后重试。", {
          ephemeral: false,
        });
        return;
      }

      const key = interaction.options.getInteger("key");
      const content = key !== null ? `#${key} /reset all` : "/reset all";

      await safeReply(interaction, "收到，正在重置全群对话…", {
        ephemeral: false,
      });

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
          isGuildOwner: interaction.guildId ? isGuildOwner : undefined,
          isGuildAdmin: interaction.guildId ? isGuildAdmin : undefined,
        },
      };
      await this.emitEvent(event);
      return;
    }
    if (commandName === "model") {
      const channelId = interaction.channelId;
      if (!channelId) {
        await safeReply(interaction, "缺少 channelId，无法处理该指令。", {
          ephemeral: false,
        });
        return;
      }
      const botId = this.botUserId ?? this.client.user?.id ?? "";
      if (!botId) {
        await safeReply(interaction, "Bot 尚未就绪，请稍后重试。", {
          ephemeral: false,
        });
        return;
      }

      const name = interaction.options.getString("name", true).trim();
      const content = `/model ${name}`;

      await safeReply(interaction, "收到，正在切换模型…", { ephemeral: false });

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
          isGuildOwner: interaction.guildId ? isGuildOwner : undefined,
          isGuildAdmin: interaction.guildId ? isGuildAdmin : undefined,
        },
      };
      await this.emitEvent(event);
      return;
    }
    await safeReply(interaction, `未知指令：/${commandName}`, {
      ephemeral: false,
    });
  }

  private async handleWorldCommand(
    interaction: ChatInputCommandInteraction,
    flags: { isGuildOwner: boolean; isGuildAdmin: boolean },
  ): Promise<void> {
    const subcommand = interaction.options.getSubcommand();
    if (subcommand === "create") {
      await this.handleWorldCreate(interaction, flags);
      return;
    }
    if (subcommand === "help") {
      await this.handleWorldHelp(interaction);
      return;
    }
    if (subcommand === "list") {
      await this.handleWorldList(interaction);
      return;
    }
    if (subcommand === "info") {
      const worldId = interaction.options.getInteger("world_id", true);
      await this.handleWorldInfo(interaction, worldId);
      return;
    }
    if (subcommand === "rules") {
      const worldId = interaction.options.getInteger("world_id", true);
      await this.handleWorldRules(interaction, worldId);
      return;
    }
    if (subcommand === "canon") {
      const query = interaction.options.getString("query", true);
      const worldId = interaction.options.getInteger("world_id") ?? undefined;
      await this.handleWorldCanon(interaction, { query, worldId });
      return;
    }
    if (subcommand === "join") {
      await this.handleWorldJoin(interaction);
      return;
    }
    if (subcommand === "stats") {
      const worldId = interaction.options.getInteger("world_id", true);
      await this.handleWorldStats(interaction, worldId);
      return;
    }
    if (subcommand === "status") {
      const worldId = interaction.options.getInteger("world_id", true);
      await this.handleWorldStats(interaction, worldId);
      return;
    }
    if (subcommand === "search") {
      const query = interaction.options.getString("query", true);
      const limit = interaction.options.getInteger("limit") ?? undefined;
      await this.handleWorldSearch(interaction, { query, limit });
      return;
    }
    if (subcommand === "edit") {
      const worldId = interaction.options.getInteger("world_id", true);
      const message = interaction.options.getString("message") ?? undefined;
      const document =
        interaction.options.getAttachment("document") ?? undefined;
      await this.handleWorldEdit(interaction, { worldId, message, document });
      return;
    }
    if (subcommand === "done") {
      await this.handleWorldDone(interaction);
      return;
    }
    await safeReply(interaction, `未知子命令：/world ${subcommand}`, {
      ephemeral: false,
    });
  }

  private async handleWorldCreate(
    interaction: ChatInputCommandInteraction,
    flags: { isGuildOwner: boolean; isGuildAdmin: boolean },
  ): Promise<void> {
    if (!interaction.guildId || !interaction.guild) {
      await safeReply(interaction, "该指令仅支持在服务器内使用。", {
        ephemeral: true,
      });
      return;
    }
    const worldNameRaw = interaction.options.getString("name")?.trim() ?? "";
    const messageRaw = interaction.options.getString("message")?.trim() ?? "";
    const document = interaction.options.getAttachment("document");
    const traceId = createTraceId();
    feishuLogJson({
      event: "discord.world.create.start",
      traceId,
      interactionId: interaction.id,
      guildId: interaction.guildId,
      channelId: interaction.channelId,
      userId: interaction.user.id,
      hasDocument: Boolean(document),
      documentName: document?.name,
      documentSize: document?.size,
      messagePreview: previewTextForLog(messageRaw, 1200),
      messageLength: messageRaw.length,
      worldName: worldNameRaw,
    });

    const groupPath = await this.groupRepository.ensureGroupDir(
      interaction.guildId,
    );
    const groupConfig = await this.groupRepository.loadConfig(groupPath);
    const policy = groupConfig.world.createPolicy;
    const isConfiguredAdmin = groupConfig.adminUsers.includes(
      interaction.user.id,
    );
    const isGuildAdmin = flags.isGuildOwner || flags.isGuildAdmin;
    const isWhitelisted = groupConfig.world.createWhitelist.includes(
      interaction.user.id,
    );
    const allowed =
      policy === "open" ||
      isConfiguredAdmin ||
      isGuildAdmin ||
      (policy === "whitelist" && isWhitelisted);
    if (!allowed) {
      feishuLogJson({
        event: "discord.world.create.denied",
        traceId,
        interactionId: interaction.id,
        policy,
        isConfiguredAdmin,
        isGuildAdmin,
        isWhitelisted,
      });
      await safeReply(
        interaction,
        `无权限：当前 createPolicy=${policy}（默认 admin）。`,
        { ephemeral: true },
      );
      return;
    }

    const guild = interaction.guild;
    await safeReply(interaction, "收到，正在创建世界草稿…", {
      ephemeral: true,
    });

    try {
      let source: { filename: string; content: string };
      const nowIso = new Date().toISOString();
      const worldId = await this.worldStore.nextWorldId();
      const worldName = worldNameRaw || `World-${worldId}`;
      feishuLogJson({
        event: "discord.world.create.draft_id_allocated",
        traceId,
        interactionId: interaction.id,
        worldId,
        worldName,
      });

      if (document) {
        try {
          source = await fetchDiscordTextAttachment(document, {
            logger: this.logger,
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (msg.includes("unsupported attachment type")) {
            throw new Error("设定文档类型不支持：仅支持 txt/md/docx", {
              cause: err,
            });
          }
          throw new Error(`设定文档读取失败：${msg}`, { cause: err });
        }
      } else if (messageRaw) {
        source = { filename: "message.md", content: messageRaw };
      } else {
        source = {
          filename: "source.md",
          content: [
            `# 设定原文（尚未提供）`,
            ``,
            `你可以：`,
            `- 直接在本话题里发送设定内容（多轮对话补全也可以）`,
            `- 上传 txt/md/docx 等文档作为设定原文`,
            ``,
          ].join("\n"),
        };
      }

      await this.worldStore.createWorldDraft({
        id: worldId,
        homeGuildId: interaction.guildId,
        creatorId: interaction.user.id,
        name: worldName,
        createdAt: nowIso,
        updatedAt: nowIso,
      });

      await this.worldFiles.ensureDefaultFiles({
        worldId,
        worldName,
        creatorId: interaction.user.id,
      });
      await this.worldFiles.writeSourceDocument(worldId, source);
      await this.worldFiles.appendEvent(worldId, {
        type: "world_draft_created",
        worldId,
        guildId: interaction.guildId,
        userId: interaction.user.id,
      });
      await this.worldFiles.appendEvent(worldId, {
        type: "world_source_uploaded",
        worldId,
        guildId: interaction.guildId,
        userId: interaction.user.id,
        filename: source.filename,
      });

      await this.ensureWorldBuildGroupAgent({
        worldId,
        worldName,
      });

      let buildConversationChannelId: string | null = null;
      let buildConversationMention = "(创建话题失败)";
      try {
        const channel = await this.createCreatorOnlyChannel({
          guild,
          name: `world-build-w${worldId}`,
          creatorUserId: interaction.user.id,
          reason: `world draft by ${interaction.user.id}`,
        });
        buildConversationChannelId = channel.id;
        buildConversationMention = `<#${channel.id}>`;
        await this.worldStore.setChannelGroupId(
          channel.id,
          buildWorldBuildGroupId(worldId),
        );
        await this.worldFiles.appendEvent(worldId, {
          type: "world_draft_build_channel_created",
          worldId,
          guildId: interaction.guildId,
          userId: interaction.user.id,
          channelId: channel.id,
        });
      } catch (err) {
        this.logger.warn({ err }, "Failed to create world build conversation");
      }

      if (buildConversationChannelId) {
        feishuLogJson({
          event: "discord.world.create.build_conversation_ready",
          traceId,
          interactionId: interaction.id,
          worldId,
          channelId: buildConversationChannelId,
        });
        await this.emitSyntheticWorldBuildKickoff({
          guildId: interaction.guildId,
          channelId: buildConversationChannelId,
          userId: interaction.user.id,
          worldId,
          worldName,
          traceId,
        });
        feishuLogJson({
          event: "discord.world.create.kickoff_emitted",
          traceId,
          interactionId: interaction.id,
          worldId,
          channelId: buildConversationChannelId,
        });
      }

      feishuLogJson({
        event: "discord.world.create.success",
        traceId,
        interactionId: interaction.id,
        worldId,
        worldName,
        buildConversationChannelId,
      });
      await safeReply(
        interaction,
        [
          `世界草稿已创建：W${worldId} ${worldName}`,
          `继续补全：${buildConversationMention}`,
          `发布世界：在子话题中执行 /world done（发布后会自动创建子空间并把你拉进去）`,
        ].join("\n"),
        { ephemeral: true },
      );
    } catch (err) {
      this.logger.error({ err }, "Failed to create world draft");
      feishuLogJson({
        event: "discord.world.create.error",
        traceId,
        interactionId: interaction.id,
        errName: err instanceof Error ? err.name : "Error",
        errMessage: err instanceof Error ? err.message : String(err),
      });
      await safeReply(
        interaction,
        `创建失败：${err instanceof Error ? err.message : String(err)}`,
        { ephemeral: true },
      );
    }
  }

  private async handleWorldHelp(
    interaction: ChatInputCommandInteraction,
  ): Promise<void> {
    await safeReply(
      interaction,
      [
        "世界系统指令：",
        "- /world create [name:<世界名称>] [message:<设定摘要>] [document:<设定文档>]（默认仅管理员；可配置 world.createPolicy；允许空输入）",
        "  - 创建后会自动创建私密话题，多轮补全；在话题里用 /world done 发布世界并创建子空间",
        "- /world list [limit:<1-100>]",
        "- /world search query:<关键词> [limit:<1-50>]",
        "- /world info world_id:<世界ID>",
        "- /world rules world_id:<世界ID>",
        "- /world canon query:<关键词> [world_id:<世界ID>]（搜索该世界正典：名称/世界卡/规则；可在入口频道省略 world_id）",
        "- /world join（仅在世界子空间的 world-join 频道执行）",
        "- /world stats world_id:<世界ID>（或 /world status）",
        "- /world edit world_id:<世界ID>（仅创作者，创建编辑话题；私密可见）",
        "- /world done（仅创作者，结束当前构建/编辑话题；草稿会在此时发布）",
        "",
        "提示：",
        "- 未加入世界时看不到 roleplay/proposals；加入后会自动获得进入权限",
        "- 访客数=join 人数；角色数=该世界角色数（均持久化）",
      ].join("\n"),
      { ephemeral: true },
    );
  }

  private async handleWorldList(
    interaction: ChatInputCommandInteraction,
  ): Promise<void> {
    const limit = interaction.options.getInteger("limit") ?? 20;
    const ids = await this.worldStore.listWorldIds(limit);
    if (ids.length === 0) {
      await safeReply(interaction, "暂无世界。", { ephemeral: false });
      return;
    }
    const metas = await Promise.all(
      ids.map((id) => this.worldStore.getWorld(id)),
    );
    const lines = metas
      .filter((meta): meta is NonNullable<typeof meta> => Boolean(meta))
      .map(
        (meta) => `W${meta.id} ${meta.name}（入口 guild:${meta.homeGuildId}）`,
      );
    await safeReply(interaction, lines.join("\n"), { ephemeral: false });
  }

  private async handleWorldInfo(
    interaction: ChatInputCommandInteraction,
    worldId: number,
  ): Promise<void> {
    const meta = await this.worldStore.getWorld(worldId);
    if (!meta) {
      await safeReply(interaction, `世界不存在：W${worldId}`, {
        ephemeral: false,
      });
      return;
    }
    if (meta.status === "draft" && meta.creatorId !== interaction.user.id) {
      await safeReply(
        interaction,
        `世界尚未发布：W${meta.id}（仅创作者可见）`,
        {
          ephemeral: false,
        },
      );
      return;
    }
    const card = await this.worldFiles.readWorldCard(meta.id);
    let joinChannelId: string | undefined;
    if (meta.status !== "draft") {
      joinChannelId = meta.joinChannelId;
      if (
        meta.status === "active" &&
        interaction.guild &&
        interaction.guildId === meta.homeGuildId
      ) {
        const ensured = await this.ensureWorldJoinChannel({
          guild: interaction.guild,
          meta,
        }).catch(() => null);
        if (ensured) {
          joinChannelId = ensured;
        }
      }
    }
    const channels =
      meta.status === "draft"
        ? []
        : [
            `信息：<#${meta.infoChannelId}>`,
            joinChannelId
              ? `加入：<#${joinChannelId}>（在该频道执行 /world join）`
              : `加入入口：未配置`,
            `入口：<#${meta.roleplayChannelId}>`,
          ];
    const header = [
      `W${meta.id} ${meta.name}`,
      `入口 guild:${meta.homeGuildId}`,
      `状态：${meta.status === "draft" ? "draft(未发布)" : meta.status}`,
      `访客数：${await this.worldStore.memberCount(meta.id)}`,
      `角色数：${await this.worldStore.characterCount(meta.id)}`,
      ...channels,
      ``,
    ].join("\n");
    const body = card?.trim() ? card.trim() : "(世界卡缺失)";
    await replyLongText(interaction, `${header}${body}`, { ephemeral: false });
  }

  private async handleWorldRules(
    interaction: ChatInputCommandInteraction,
    worldId: number,
  ): Promise<void> {
    const meta = await this.worldStore.getWorld(worldId);
    if (!meta) {
      await safeReply(interaction, `世界不存在：W${worldId}`, {
        ephemeral: false,
      });
      return;
    }
    if (meta.status === "draft" && meta.creatorId !== interaction.user.id) {
      await safeReply(
        interaction,
        `世界尚未发布：W${meta.id}（仅创作者可见）`,
        {
          ephemeral: false,
        },
      );
      return;
    }
    const rules = await this.worldFiles.readRules(meta.id);
    const body = rules?.trim() ? rules.trim() : "(规则缺失)";
    await replyLongText(interaction, body, { ephemeral: false });
  }

  private async handleWorldCanon(
    interaction: ChatInputCommandInteraction,
    input: { query: string; worldId?: number },
  ): Promise<void> {
    const query = input.query.trim();
    if (!query) {
      await safeReply(interaction, "query 不能为空。", { ephemeral: false });
      return;
    }

    const inferredWorldId = interaction.channelId
      ? await this.worldStore.getWorldIdByChannel(interaction.channelId)
      : null;
    const worldId = input.worldId ?? inferredWorldId;
    if (!worldId) {
      await safeReply(
        interaction,
        "缺少 world_id：请在世界入口频道内执行，或显式提供 world_id。",
        { ephemeral: false },
      );
      return;
    }

    const meta = await this.worldStore.getWorld(worldId);
    if (!meta) {
      await safeReply(interaction, `世界不存在：W${worldId}`, {
        ephemeral: false,
      });
      return;
    }
    if (meta.status === "draft" && meta.creatorId !== interaction.user.id) {
      await safeReply(
        interaction,
        `世界尚未发布：W${meta.id}（仅创作者可见）`,
        { ephemeral: false },
      );
      return;
    }

    const lowered = query.toLowerCase();
    const [card, rules] = await Promise.all([
      this.worldFiles.readWorldCard(meta.id),
      this.worldFiles.readRules(meta.id),
    ]);
    const hits: string[] = [];
    if (meta.name.toLowerCase().includes(lowered)) {
      hits.push("name");
    }
    if (card?.toLowerCase().includes(lowered)) {
      hits.push("world-card");
    }
    if (rules?.toLowerCase().includes(lowered)) {
      hits.push("rules");
    }

    if (hits.length === 0) {
      await safeReply(
        interaction,
        `W${meta.id} ${meta.name}\n未找到包含「${query}」的正典内容。`,
        { ephemeral: false },
      );
      return;
    }
    await safeReply(
      interaction,
      `W${meta.id} ${meta.name}\n命中：${hits.join(", ")}`,
      { ephemeral: false },
    );
  }

  private async handleWorldJoin(
    interaction: ChatInputCommandInteraction,
  ): Promise<void> {
    const inferredWorldId = await this.inferWorldIdFromWorldSubspace(
      interaction,
    ).catch(() => null);
    if (!inferredWorldId) {
      await safeReply(
        interaction,
        "请在目标世界子空间的 world-join 频道执行 /world join（不需要 world_id）。",
        { ephemeral: true },
      );
      return;
    }

    const meta = await this.worldStore.getWorld(inferredWorldId);
    if (!meta) {
      await safeReply(interaction, `世界不存在：W${inferredWorldId}`, {
        ephemeral: true,
      });
      return;
    }
    if (meta.status !== "active") {
      await safeReply(
        interaction,
        `无法加入：世界尚未发布（W${meta.id} 当前状态=${meta.status}）`,
        { ephemeral: true },
      );
      return;
    }
    if (!interaction.guildId || interaction.guildId !== meta.homeGuildId) {
      await safeReply(
        interaction,
        `无法加入：该世界入口在 guild:${meta.homeGuildId}（请先加入该服务器后再执行 /world join）。`,
        { ephemeral: true },
      );
      return;
    }
    if (!interaction.guild) {
      await safeReply(interaction, "无法获取服务器信息，请稍后重试。", {
        ephemeral: true,
      });
      return;
    }

    const joinChannelId = await this.ensureWorldJoinChannel({
      guild: interaction.guild,
      meta,
    });
    if (!joinChannelId) {
      await safeReply(
        interaction,
        "加入入口未配置或创建失败，请联系管理员/创作者修复。",
        { ephemeral: true },
      );
      return;
    }

    const baseChannelId = await this.resolveBaseChannelId(interaction);
    if (!baseChannelId || baseChannelId !== joinChannelId) {
      await safeReply(
        interaction,
        `请在 <#${joinChannelId}> 执行 /world join（不需要 world_id）。`,
        { ephemeral: true },
      );
      return;
    }

    try {
      const member = await interaction.guild.members.fetch(interaction.user.id);
      await member.roles.add(meta.roleId, "world join");
      const added = await this.worldStore.addMember(
        meta.id,
        interaction.user.id,
      );
      if (added) {
        await this.worldFiles.appendEvent(meta.id, {
          type: "world_joined",
          worldId: meta.id,
          userId: interaction.user.id,
        });
      }
      await safeReply(
        interaction,
        `已加入世界：W${meta.id} ${meta.name}\n入口：<#${meta.roleplayChannelId}>`,
        { ephemeral: true },
      );
    } catch (err) {
      await safeReply(
        interaction,
        `加入失败：${err instanceof Error ? err.message : String(err)}`,
        { ephemeral: true },
      );
    }
  }

  private async handleWorldStats(
    interaction: ChatInputCommandInteraction,
    worldId: number,
  ): Promise<void> {
    const meta = await this.worldStore.getWorld(worldId);
    if (!meta) {
      await safeReply(interaction, `世界不存在：W${worldId}`, {
        ephemeral: false,
      });
      return;
    }
    if (meta.status === "draft" && meta.creatorId !== interaction.user.id) {
      await safeReply(
        interaction,
        `世界尚未发布：W${meta.id}（仅创作者可见）`,
        {
          ephemeral: false,
        },
      );
      return;
    }
    const [members, characters] = await Promise.all([
      this.worldStore.memberCount(meta.id),
      this.worldStore.characterCount(meta.id),
    ]);
    await safeReply(
      interaction,
      `W${meta.id} ${meta.name}\n状态：${
        meta.status === "draft" ? "draft(未发布)" : meta.status
      }\n访客数：${members}\n角色数：${characters}`,
      { ephemeral: false },
    );
  }

  private async handleWorldSearch(
    interaction: ChatInputCommandInteraction,
    input: { query: string; limit?: number },
  ): Promise<void> {
    const query = input.query.trim();
    if (!query) {
      await safeReply(interaction, "query 不能为空。", { ephemeral: false });
      return;
    }
    const limit = Math.max(1, Math.min(50, Math.floor(input.limit ?? 10)));

    const ids = await this.worldStore.listWorldIds(200);
    if (ids.length === 0) {
      await safeReply(interaction, "暂无世界。", { ephemeral: false });
      return;
    }

    const metas = await Promise.all(
      ids.map((id) => this.worldStore.getWorld(id)),
    );
    const lowered = query.toLowerCase();
    const results: string[] = [];

    for (const meta of metas) {
      if (!meta || meta.status !== "active") {
        continue;
      }
      if (results.length >= limit) {
        break;
      }
      const nameHit = meta.name.toLowerCase().includes(lowered);
      if (nameHit) {
        results.push(`W${meta.id} ${meta.name}（命中：name）`);
        continue;
      }
      const [card, rules] = await Promise.all([
        this.worldFiles.readWorldCard(meta.id),
        this.worldFiles.readRules(meta.id),
      ]);
      if (card?.toLowerCase().includes(lowered)) {
        results.push(`W${meta.id} ${meta.name}（命中：world-card）`);
        continue;
      }
      if (rules?.toLowerCase().includes(lowered)) {
        results.push(`W${meta.id} ${meta.name}（命中：rules）`);
      }
    }

    if (results.length === 0) {
      await safeReply(interaction, `未找到包含「${query}」的世界。`, {
        ephemeral: false,
      });
      return;
    }
    await safeReply(interaction, results.join("\n"), { ephemeral: false });
  }

  private async handleWorldEdit(
    interaction: ChatInputCommandInteraction,
    input: { worldId: number; message?: string; document?: Attachment },
  ): Promise<void> {
    const traceId = createTraceId();
    feishuLogJson({
      event: "discord.world.edit.start",
      traceId,
      interactionId: interaction.id,
      guildId: interaction.guildId,
      channelId: interaction.channelId,
      userId: interaction.user.id,
      worldId: input.worldId,
      hasDocument: Boolean(input.document),
      documentName: input.document?.name,
      documentSize: input.document?.size,
      messagePreview: previewTextForLog(input.message?.trim() ?? "", 1200),
      messageLength: input.message?.trim().length ?? 0,
    });
    if (!interaction.guildId || !interaction.guild) {
      await safeReply(interaction, "该指令仅支持在服务器内使用。", {
        ephemeral: true,
      });
      return;
    }
    const meta = await this.worldStore.getWorld(input.worldId);
    if (!meta) {
      await safeReply(interaction, `世界不存在：W${input.worldId}`, {
        ephemeral: true,
      });
      return;
    }
    if (meta.creatorId !== interaction.user.id) {
      await safeReply(interaction, "无权限：只有世界创作者可以编辑世界。", {
        ephemeral: true,
      });
      return;
    }
    if (interaction.guildId !== meta.homeGuildId) {
      await safeReply(
        interaction,
        `请在世界入口服务器执行该指令：guild:${meta.homeGuildId}`,
        { ephemeral: true },
      );
      return;
    }

    const note = input.message?.trim() ?? "";
    const attachment = input.document;
    if (attachment) {
      try {
        const uploaded = await fetchDiscordTextAttachment(attachment, {
          logger: this.logger,
        });
        const merged = note
          ? `# 补充说明\n\n${note}\n\n---\n\n${uploaded.content}`
          : uploaded.content;
        await this.worldFiles.writeSourceDocument(input.worldId, {
          filename: uploaded.filename,
          content: merged,
        });
        await this.worldFiles.appendEvent(input.worldId, {
          type: "world_source_uploaded",
          worldId: input.worldId,
          guildId: interaction.guildId,
          userId: interaction.user.id,
          filename: uploaded.filename,
        });
      } catch (err) {
        feishuLogJson({
          event: "discord.world.edit.document_error",
          traceId,
          interactionId: interaction.id,
          worldId: input.worldId,
          errName: err instanceof Error ? err.name : "Error",
          errMessage: err instanceof Error ? err.message : String(err),
        });
        const msg = err instanceof Error ? err.message : String(err);
        const userMessage = msg.includes("unsupported attachment type")
          ? "补充设定文档类型不支持：仅支持 txt/md/docx"
          : `补充设定文档读取失败：${msg}`;
        await safeReply(interaction, userMessage, { ephemeral: true });
        return;
      }
    } else if (note) {
      const existing =
        (await this.worldFiles.readSourceDocument(input.worldId)) ?? "";
      const merged = [
        existing.trimEnd(),
        "",
        "---",
        "",
        `# 补充说明（${new Date().toISOString()}）`,
        "",
        note,
        "",
      ]
        .join("\n")
        .trimStart();
      await this.worldFiles.writeSourceDocument(input.worldId, {
        filename: "note.md",
        content: merged,
      });
      await this.worldFiles.appendEvent(input.worldId, {
        type: "world_source_note_appended",
        worldId: input.worldId,
        guildId: interaction.guildId,
        userId: interaction.user.id,
      });
    }

    const guild = interaction.guild;
    let buildConversationChannelId: string | null = null;
    let buildConversationMention = "(创建话题失败)";
    try {
      if (meta.status !== "draft" && meta.buildChannelId) {
        const created = await this.tryCreatePrivateThread({
          guild,
          parentChannelId: meta.buildChannelId,
          name: `世界编辑 W${meta.id}`,
          reason: `world edit by ${interaction.user.id}`,
          memberUserId: interaction.user.id,
        });
        if (created) {
          buildConversationChannelId = created.threadId;
          buildConversationMention = `<#${created.threadId}>`;
          await this.worldStore.setChannelGroupId(
            created.threadId,
            buildWorldBuildGroupId(meta.id),
          );
          await this.worldFiles.appendEvent(meta.id, {
            type: "world_edit_thread_created",
            worldId: meta.id,
            guildId: interaction.guildId,
            userId: interaction.user.id,
            threadId: created.threadId,
            parentChannelId: created.parentChannelId,
          });
        }
      }

      if (!buildConversationChannelId) {
        const channel = await this.createCreatorOnlyChannel({
          guild,
          name: `world-edit-w${meta.id}`,
          creatorUserId: interaction.user.id,
          reason: `world edit by ${interaction.user.id}`,
        });
        buildConversationChannelId = channel.id;
        buildConversationMention = `<#${channel.id}>`;
        await this.worldStore.setChannelGroupId(
          channel.id,
          buildWorldBuildGroupId(meta.id),
        );
        await this.worldFiles.appendEvent(meta.id, {
          type: "world_edit_build_channel_created",
          worldId: meta.id,
          guildId: interaction.guildId,
          userId: interaction.user.id,
          channelId: channel.id,
        });
      }
    } catch (err) {
      this.logger.warn({ err }, "Failed to create world edit thread");
    }

    if (buildConversationChannelId) {
      await this.emitSyntheticWorldBuildKickoff({
        guildId: interaction.guildId,
        channelId: buildConversationChannelId,
        userId: interaction.user.id,
        worldId: meta.id,
        worldName: meta.name,
        traceId,
      });
    }

    feishuLogJson({
      event: "discord.world.edit.success",
      traceId,
      interactionId: interaction.id,
      worldId: meta.id,
      status: meta.status,
      buildConversationChannelId,
    });
    await safeReply(
      interaction,
      [
        `已创建世界编辑话题：${buildConversationMention}`,
        meta.status === "draft"
          ? "提示：该世界仍是草稿，完成后在话题中执行 /world done 发布。"
          : "完成后在话题中执行 /world done 结束编辑。",
      ].join("\n"),
      { ephemeral: true },
    );
  }

  private async handleWorldDone(
    interaction: ChatInputCommandInteraction,
  ): Promise<void> {
    if (!interaction.guildId || !interaction.guild) {
      await safeReply(interaction, "该指令仅支持在服务器内使用。", {
        ephemeral: false,
      });
      return;
    }
    const channel = interaction.channel;
    const groupId = await this.worldStore.getGroupIdByChannel(
      interaction.channelId,
    );
    const parsed = groupId ? parseWorldGroup(groupId) : null;
    if (!parsed || parsed.kind !== "build") {
      await safeReply(interaction, "当前频道不属于世界构建会话，无法关闭。", {
        ephemeral: false,
      });
      return;
    }
    if (!channel) {
      await safeReply(interaction, "无法获取频道信息，请稍后重试。", {
        ephemeral: false,
      });
      return;
    }
    const isThread =
      "isThread" in channel &&
      typeof (channel as { isThread?: () => boolean }).isThread ===
        "function" &&
      (channel as { isThread: () => boolean }).isThread();

    const world = await this.worldStore.getWorld(parsed.worldId);
    if (!world) {
      await safeReply(interaction, `世界不存在：W${parsed.worldId}`, {
        ephemeral: false,
      });
      return;
    }
    if (world.creatorId !== interaction.user.id) {
      await safeReply(interaction, "无权限：只有世界创作者可以关闭该话题。", {
        ephemeral: false,
      });
      return;
    }

    if (
      !isThread &&
      world.status !== "draft" &&
      "buildChannelId" in world &&
      world.buildChannelId === interaction.channelId
    ) {
      await safeReply(
        interaction,
        "请在世界构建/编辑话题（Thread）内执行 /world done。当前频道用于承载话题，请先用 /world edit 创建话题。",
        { ephemeral: false },
      );
      return;
    }

    const nowIso = new Date().toISOString();
    if (world.status === "draft") {
      const card = await this.worldFiles.readWorldCard(world.id);
      const extractedName = extractWorldNameFromCard(card);
      const resolvedName = extractedName ?? world.name;
      try {
        const created = await this.createWorldSubspace({
          guild: interaction.guild,
          worldId: world.id,
          worldName: resolvedName,
          creatorUserId: interaction.user.id,
        });

        await this.worldStore.publishWorld({
          id: world.id,
          homeGuildId: world.homeGuildId,
          creatorId: world.creatorId,
          name: resolvedName,
          createdAt: world.createdAt,
          updatedAt: nowIso,
          roleId: created.roleId,
          categoryId: created.categoryId,
          infoChannelId: created.infoChannelId,
          joinChannelId: created.joinChannelId,
          roleplayChannelId: created.roleplayChannelId,
          proposalsChannelId: created.proposalsChannelId,
          voiceChannelId: created.voiceChannelId,
          buildChannelId: created.buildChannelId,
        });

        await this.ensureWorldGroupAgent({
          worldId: world.id,
          worldName: resolvedName,
        });
        await this.ensureWorldBuildGroupAgent({
          worldId: world.id,
          worldName: resolvedName,
        });

        await this.worldStore.setChannelGroupId(
          created.buildChannelId,
          buildWorldBuildGroupId(world.id),
        );

        const member = await interaction.guild.members.fetch(
          interaction.user.id,
        );
        await member.roles.add(created.roleId, "world creator auto-join");
        await this.worldStore.addMember(world.id, interaction.user.id);

        await this.worldFiles.appendEvent(world.id, {
          type: "world_published",
          worldId: world.id,
          guildId: world.homeGuildId,
          userId: interaction.user.id,
        });

        const intro = [
          `世界已发布：W${world.id} ${resolvedName}`,
          `- 加入：在 <#${created.joinChannelId}> 执行 /world join`,
          `- 状态：/world status world_id:${world.id}`,
          `- 角色：/character create（在 <#${created.roleplayChannelId}> 内可省略 world_id）`,
        ].join("\n");
        try {
          const info = await interaction.guild.channels.fetch(
            created.infoChannelId,
          );
          await (info as { send: (content: string) => Promise<unknown> }).send(
            intro,
          );
        } catch {
          // ignore
        }
        try {
          await this.sendLongTextToChannel({
            guildId: world.homeGuildId,
            channelId: created.joinChannelId,
            content: [
              `欢迎来到：W${world.id} ${resolvedName}`,
              `在本频道执行 /world join 加入世界。`,
            ].join("\n"),
          });
        } catch {
          // ignore
        }
        try {
          await this.pushWorldInfoSnapshot({
            guildId: world.homeGuildId,
            worldId: world.id,
            worldName: resolvedName,
            infoChannelId: created.infoChannelId,
            joinChannelId: created.joinChannelId,
          });
        } catch {
          // ignore
        }

        await safeReply(
          interaction,
          [
            `世界已发布：W${world.id} ${resolvedName}`,
            `入口：<#${created.roleplayChannelId}>`,
            `信息：<#${created.infoChannelId}>`,
            `加入：<#${created.joinChannelId}>（执行 /world join）`,
          ].join("\n"),
          { ephemeral: false },
        );
      } catch (err) {
        await safeReply(
          interaction,
          `发布失败：${err instanceof Error ? err.message : String(err)}`,
          { ephemeral: false },
        );
        return;
      }
    } else {
      await safeReply(
        interaction,
        `已关闭世界构建话题：W${world.id} ${world.name}`,
        { ephemeral: false },
      );
      let joinChannelId = world.joinChannelId;
      if (world.status === "active") {
        const ensured = await this.ensureWorldJoinChannel({
          guild: interaction.guild,
          meta: world,
        }).catch(() => null);
        if (ensured) {
          joinChannelId = ensured;
        }
      }
      try {
        await this.pushWorldInfoSnapshot({
          guildId: world.homeGuildId,
          worldId: world.id,
          worldName: world.name,
          infoChannelId: world.infoChannelId,
          joinChannelId,
        });
      } catch {
        // ignore
      }
    }

    if (isThread) {
      try {
        await (
          channel as unknown as {
            setArchived: (v: boolean) => Promise<unknown>;
          }
        ).setArchived(true);
      } catch {
        // ignore
      }
      try {
        await (
          channel as unknown as { setLocked: (v: boolean) => Promise<unknown> }
        ).setLocked(true);
      } catch {
        // ignore
      }
    } else {
      try {
        await (
          channel as unknown as {
            delete: (reason?: string) => Promise<unknown>;
          }
        ).delete("world build closed");
      } catch {
        // ignore
      }
    }

    await this.worldFiles.appendEvent(world.id, {
      type: "world_build_closed",
      worldId: world.id,
      userId: interaction.user.id,
      channelId: interaction.channelId,
      isThread,
    });
  }

  private async handleCharacterCommand(
    interaction: ChatInputCommandInteraction,
    _flags: { isGuildOwner: boolean; isGuildAdmin: boolean },
  ): Promise<void> {
    const subcommand = interaction.options.getSubcommand();
    if (subcommand === "create") {
      await this.handleCharacterCreate(interaction);
      return;
    }
    if (subcommand === "help") {
      await this.handleCharacterHelp(interaction);
      return;
    }
    if (subcommand === "view") {
      const characterId = interaction.options.getInteger("character_id", true);
      await this.handleCharacterView(interaction, characterId);
      return;
    }
    if (subcommand === "act") {
      const characterId = interaction.options.getInteger("character_id", true);
      await this.handleCharacterAct(interaction, characterId);
      return;
    }
    if (subcommand === "close") {
      await this.handleCharacterClose(interaction);
      return;
    }
    await safeReply(interaction, `未知子命令：/character ${subcommand}`, {
      ephemeral: false,
    });
  }

  private async handleCharacterCreate(
    interaction: ChatInputCommandInteraction,
  ): Promise<void> {
    const explicitWorldId = interaction.options.getInteger("world_id");
    const inferredWorldId = interaction.channelId
      ? await this.worldStore.getWorldIdByChannel(interaction.channelId)
      : null;
    const worldId = explicitWorldId ?? inferredWorldId;
    if (!worldId) {
      await safeReply(
        interaction,
        "缺少 world_id：请在世界入口频道内执行，或显式提供 world_id。",
        { ephemeral: false },
      );
      return;
    }
    const traceId = createTraceId();
    feishuLogJson({
      event: "discord.character.create.start",
      traceId,
      interactionId: interaction.id,
      guildId: interaction.guildId,
      channelId: interaction.channelId,
      userId: interaction.user.id,
      worldId,
    });
    const world = await this.worldStore.getWorld(worldId);
    if (!world) {
      feishuLogJson({
        event: "discord.character.create.world_missing",
        traceId,
        interactionId: interaction.id,
        worldId,
      });
      await safeReply(interaction, `世界不存在：W${worldId}`, {
        ephemeral: false,
      });
      return;
    }
    if (world.status !== "active") {
      await safeReply(
        interaction,
        `世界尚未发布，无法创建角色：W${world.id}（状态=${world.status}）`,
        { ephemeral: false },
      );
      return;
    }
    const isMember = await this.worldStore.isMember(
      world.id,
      interaction.user.id,
    );
    if (!isMember) {
      const joinHint = world.joinChannelId
        ? `你尚未加入该世界：请先在 <#${world.joinChannelId}> 执行 /world join`
        : "你尚未加入该世界：请先在该世界子空间的 world-join 频道执行 /world join";
      await safeReply(interaction, joinHint, { ephemeral: false });
      return;
    }
    if (!interaction.guildId || !interaction.guild) {
      await safeReply(interaction, "该指令仅支持在服务器内使用。", {
        ephemeral: false,
      });
      return;
    }
    if (interaction.guildId !== world.homeGuildId) {
      await safeReply(
        interaction,
        `请在世界入口服务器执行该指令：guild:${world.homeGuildId}`,
        { ephemeral: false },
      );
      return;
    }
    const guild = interaction.guild;

    const name = interaction.options.getString("name", true).trim();
    if (!name) {
      await safeReply(interaction, "角色名不能为空。", { ephemeral: false });
      return;
    }
    const visibilityRaw =
      (interaction.options.getString(
        "visibility",
      ) as CharacterVisibility | null) ?? "world";
    const visibility: CharacterVisibility =
      visibilityRaw === "public" || visibilityRaw === "private"
        ? visibilityRaw
        : "world";
    const description =
      interaction.options.getString("description")?.trim() ?? "";

    const characterId = await this.worldStore.nextCharacterId();
    const nowIso = new Date().toISOString();
    await this.worldStore.createCharacter({
      id: characterId,
      worldId: world.id,
      creatorId: interaction.user.id,
      name,
      visibility,
      status: "active",
      createdAt: nowIso,
      updatedAt: nowIso,
    });
    await this.worldFiles.writeCharacterCard(
      world.id,
      characterId,
      buildDefaultCharacterCard({
        worldId: world.id,
        worldName: world.name,
        characterId,
        name,
        creatorId: interaction.user.id,
        description,
      }),
    );
    await this.worldFiles.appendEvent(world.id, {
      type: "character_created",
      worldId: world.id,
      characterId,
      userId: interaction.user.id,
    });

    const characterGroupId = buildWorldCharacterBuildGroupId(
      world.id,
      characterId,
    );
    await this.ensureCharacterBuildGroupAgent({
      worldId: world.id,
      worldName: world.name,
      characterId,
      characterName: name,
    });

    let buildConversationMention = "(创建话题失败)";
    let buildConversationChannelId: string | null = null;
    try {
      const roleplayChannel = await guild.channels.fetch(
        world.roleplayChannelId,
      );
      if (!roleplayChannel) {
        throw new Error("world roleplay channel not found");
      }
      const thread = await (
        roleplayChannel as unknown as {
          threads: {
            create: (input: Record<string, unknown>) => Promise<{
              id: string;
              members?: { add: (userId: string) => Promise<unknown> };
            }>;
          };
        }
      ).threads.create({
        name: `角色构建 C${characterId} ${name}`,
        type: ChannelType.PrivateThread,
        invitable: false,
        autoArchiveDuration: 1440,
        reason: `character build by ${interaction.user.id}`,
      });
      await thread.members?.add(interaction.user.id);
      await this.worldStore.setChannelGroupId(thread.id, characterGroupId);
      buildConversationChannelId = thread.id;
      buildConversationMention = `<#${thread.id}>`;
      await this.worldFiles.appendEvent(world.id, {
        type: "character_build_thread_created",
        worldId: world.id,
        characterId,
        userId: interaction.user.id,
        threadId: thread.id,
      });
    } catch (err) {
      this.logger.warn({ err }, "Failed to create character build thread");
      feishuLogJson({
        event: "discord.character.create.thread_error",
        traceId,
        interactionId: interaction.id,
        worldId: world.id,
        characterId,
        errName: err instanceof Error ? err.name : "Error",
        errMessage: err instanceof Error ? err.message : String(err),
      });
    }

    if (buildConversationChannelId) {
      await this.emitSyntheticCharacterBuildKickoff({
        guildId: world.homeGuildId,
        channelId: buildConversationChannelId,
        userId: interaction.user.id,
        worldId: world.id,
        worldName: world.name,
        characterId,
        characterName: name,
        traceId,
      });
    }

    feishuLogJson({
      event: "discord.character.create.success",
      traceId,
      interactionId: interaction.id,
      worldId: world.id,
      characterId,
      characterName: name,
      visibility,
      buildConversationChannelId,
    });
    await safeReply(
      interaction,
      [
        `角色已创建：C${characterId} ${name}（visibility=${visibility}）`,
        `完善角色卡：${buildConversationMention}`,
        `完成后关闭：/character close`,
        `开始扮演：/character act character_id:${characterId}`,
      ].join("\n"),
      { ephemeral: false },
    );
  }

  private async handleCharacterHelp(
    interaction: ChatInputCommandInteraction,
  ): Promise<void> {
    await safeReply(
      interaction,
      [
        "角色系统指令：",
        "- /character create name:<角色名> [world_id:<世界ID>] [visibility:world|public|private] [description:<补充>]",
        "  - 在世界入口频道（world-roleplay）内可省略 world_id",
        "  - visibility 默认 world",
        "- /character view character_id:<角色ID>（遵循 visibility 权限）",
        "- /character act character_id:<角色ID>（让 bot 在该世界扮演此角色）",
        "- /character close（仅创作者，关闭当前角色构建话题）",
        "",
        "提示：",
        "- 需要先 /world join 才能创建/指定扮演角色",
      ].join("\n"),
      { ephemeral: true },
    );
  }

  private async handleCharacterView(
    interaction: ChatInputCommandInteraction,
    characterId: number,
  ): Promise<void> {
    const meta = await this.worldStore.getCharacter(characterId);
    if (!meta) {
      await safeReply(interaction, `角色不存在：C${characterId}`, {
        ephemeral: false,
      });
      return;
    }
    const allowed =
      meta.visibility === "public" ||
      (meta.visibility === "private" &&
        meta.creatorId === interaction.user.id) ||
      (meta.visibility === "world" &&
        (await this.worldStore.isMember(meta.worldId, interaction.user.id)));
    if (!allowed) {
      await safeReply(interaction, "无权限查看该角色卡。", {
        ephemeral: false,
      });
      return;
    }
    const card = await this.worldFiles.readCharacterCard(meta.worldId, meta.id);
    if (!card) {
      await safeReply(interaction, "角色卡缺失（待修复）。", {
        ephemeral: false,
      });
      return;
    }
    await replyLongText(interaction, card.trim(), {
      ephemeral: meta.visibility === "private",
    });
  }

  private async handleCharacterAct(
    interaction: ChatInputCommandInteraction,
    characterId: number,
  ): Promise<void> {
    const meta = await this.worldStore.getCharacter(characterId);
    if (!meta) {
      await safeReply(interaction, `角色不存在：C${characterId}`, {
        ephemeral: false,
      });
      return;
    }
    const isMember = await this.worldStore.isMember(
      meta.worldId,
      interaction.user.id,
    );
    if (!isMember) {
      await safeReply(interaction, "你尚未加入该世界，无法指定扮演角色。", {
        ephemeral: false,
      });
      return;
    }
    await this.worldStore.setActiveCharacter({
      worldId: meta.worldId,
      userId: interaction.user.id,
      characterId: meta.id,
    });
    await safeReply(
      interaction,
      `已设置扮演角色：C${meta.id} ${meta.name}\n请在世界入口频道内开始对话。`,
      { ephemeral: false },
    );
  }

  private async handleCharacterClose(
    interaction: ChatInputCommandInteraction,
  ): Promise<void> {
    if (!interaction.guildId || !interaction.guild) {
      await safeReply(interaction, "该指令仅支持在服务器内使用。", {
        ephemeral: false,
      });
      return;
    }
    const channel = interaction.channel;
    if (!channel || !("isThread" in channel) || !channel.isThread()) {
      await safeReply(interaction, "请在角色构建话题（Thread）内执行。", {
        ephemeral: false,
      });
      return;
    }

    const groupId = await this.worldStore.getGroupIdByChannel(
      interaction.channelId,
    );
    const parsed = groupId ? parseWorldGroup(groupId) : null;
    if (!parsed || parsed.kind !== "character_build") {
      await safeReply(interaction, "当前话题不属于角色构建会话，无法关闭。", {
        ephemeral: false,
      });
      return;
    }

    const meta = await this.worldStore.getCharacter(parsed.characterId);
    if (!meta) {
      await safeReply(interaction, `角色不存在：C${parsed.characterId}`, {
        ephemeral: false,
      });
      return;
    }
    if (meta.creatorId !== interaction.user.id) {
      await safeReply(interaction, "无权限：只有角色创作者可以关闭该话题。", {
        ephemeral: false,
      });
      return;
    }

    await safeReply(
      interaction,
      `已关闭角色构建话题：C${meta.id} ${meta.name}`,
      { ephemeral: false },
    );

    try {
      await (
        channel as unknown as { setArchived: (v: boolean) => Promise<unknown> }
      ).setArchived(true);
    } catch {
      // ignore
    }
    try {
      await (
        channel as unknown as { setLocked: (v: boolean) => Promise<unknown> }
      ).setLocked(true);
    } catch {
      // ignore
    }

    await this.worldFiles.appendEvent(meta.worldId, {
      type: "character_build_closed",
      worldId: meta.worldId,
      characterId: meta.id,
      userId: interaction.user.id,
      threadId: interaction.channelId,
    });
  }

  private async tryCreatePrivateThread(input: {
    guild: NonNullable<ChatInputCommandInteraction["guild"]>;
    parentChannelId: string;
    name: string;
    reason: string;
    memberUserId: string;
  }): Promise<{ threadId: string; parentChannelId: string } | null> {
    const resolvedParentId = input.parentChannelId.trim();
    if (!resolvedParentId) {
      return null;
    }
    const base = await input.guild.channels
      .fetch(resolvedParentId)
      .catch(() => {
        return null;
      });
    if (!base) {
      return null;
    }

    let parentChannel: unknown = base;
    if (
      parentChannel &&
      typeof parentChannel === "object" &&
      "isThread" in parentChannel &&
      typeof (parentChannel as { isThread?: () => boolean }).isThread ===
        "function" &&
      (parentChannel as { isThread: () => boolean }).isThread()
    ) {
      const parentId = (parentChannel as { parentId?: unknown }).parentId;
      if (typeof parentId === "string" && parentId.trim()) {
        const fetched = await input.guild.channels.fetch(parentId).catch(() => {
          return null;
        });
        if (fetched) {
          parentChannel = fetched;
        }
      }
    }

    const creator = (
      parentChannel as unknown as {
        threads?: {
          create?: (input: Record<string, unknown>) => Promise<unknown>;
        };
      }
    ).threads?.create;
    if (typeof creator !== "function") {
      return null;
    }

    const thread = await (
      parentChannel as unknown as {
        threads: {
          create: (input: Record<string, unknown>) => Promise<{
            id: string;
            members?: { add: (userId: string) => Promise<unknown> };
          }>;
        };
      }
    ).threads.create({
      name: input.name,
      type: ChannelType.PrivateThread,
      invitable: false,
      autoArchiveDuration: 1440,
      reason: input.reason,
    });
    await thread.members?.add(input.memberUserId);

    const parentChannelId =
      parentChannel &&
      typeof parentChannel === "object" &&
      "id" in parentChannel &&
      typeof (parentChannel as { id?: unknown }).id === "string"
        ? ((parentChannel as { id: string }).id as string)
        : resolvedParentId;
    return { threadId: thread.id, parentChannelId };
  }

  private async createCreatorOnlyChannel(input: {
    guild: NonNullable<ChatInputCommandInteraction["guild"]>;
    name: string;
    creatorUserId: string;
    reason: string;
  }): Promise<{ id: string }> {
    const channelName = input.name.trim();
    if (!channelName) {
      throw new Error("channel name is required");
    }
    const existing = input.guild.channels.cache.find(
      (candidate) =>
        candidate.type === ChannelType.GuildText &&
        candidate.name === channelName,
    );
    if (existing) {
      return { id: existing.id };
    }

    const botUserId = this.botUserId ?? this.client.user?.id ?? "";
    if (!botUserId) {
      throw new Error("Bot 尚未就绪，无法创建频道。");
    }
    const overwrites = buildDraftCreatorOnlyOverwrites({
      everyoneRoleId: input.guild.roles.everyone.id,
      creatorUserId: input.creatorUserId,
      botUserId,
    });
    const channel = await input.guild.channels.create({
      name: channelName,
      type: ChannelType.GuildText,
      permissionOverwrites: overwrites,
      reason: input.reason,
    });
    return { id: channel.id };
  }

  private async migrateWorldJoinChannels(): Promise<void> {
    const ids = await this.worldStore.listWorldIds(200);
    for (const id of ids) {
      const meta = await this.worldStore.getWorld(id);
      if (!meta || meta.status !== "active") {
        continue;
      }
      const guild = await this.client.guilds
        .fetch(meta.homeGuildId)
        .catch(() => null);
      if (!guild) {
        continue;
      }
      try {
        await this.ensureWorldJoinChannel({ guild, meta });
      } catch (err) {
        this.logger.warn(
          { err, worldId: meta.id, guildId: meta.homeGuildId },
          "Failed to ensure world join channel",
        );
      }
    }
  }

  private async ensureWorldJoinChannel(input: {
    guild: NonNullable<ChatInputCommandInteraction["guild"]>;
    meta: WorldActiveMeta;
  }): Promise<string | null> {
    const existingId = input.meta.joinChannelId?.trim();
    if (existingId) {
      const existing = await input.guild.channels
        .fetch(existingId)
        .catch(() => null);
      if (existing) {
        return existingId;
      }
    }

    const resolvedCategoryId = input.meta.categoryId?.trim() ?? "";
    let parentCategoryId: string | null = null;
    if (resolvedCategoryId) {
      const category = await input.guild.channels
        .fetch(resolvedCategoryId)
        .catch(() => null);
      if (category && category.type === ChannelType.GuildCategory) {
        parentCategoryId = category.id;
      } else {
        this.logger.warn(
          {
            worldId: input.meta.id,
            guildId: input.meta.homeGuildId,
            categoryId: resolvedCategoryId,
          },
          "World category is missing; creating join channel without parent",
        );
        await this.worldFiles.appendEvent(input.meta.id, {
          type: "world_category_missing",
          worldId: input.meta.id,
          guildId: input.meta.homeGuildId,
          categoryId: resolvedCategoryId,
        });
      }
    }

    const cached = input.guild.channels.cache.find(
      (candidate) =>
        candidate.type === ChannelType.GuildText &&
        Boolean(parentCategoryId) &&
        candidate.parentId === parentCategoryId &&
        candidate.name === "world-join",
    );
    if (cached) {
      await this.worldStore.setJoinChannelId(input.meta.id, cached.id);
      await this.worldFiles.appendEvent(input.meta.id, {
        type: "world_join_channel_detected",
        worldId: input.meta.id,
        guildId: input.meta.homeGuildId,
        joinChannelId: cached.id,
      });
      return cached.id;
    }

    const botId = this.botUserId ?? this.client.user?.id ?? "";
    if (!botId) {
      return null;
    }
    const overwrites = buildWorldBaseOverwrites({
      everyoneRoleId: input.guild.roles.everyone.id,
      worldRoleId: input.meta.roleId,
      botUserId: botId,
    });
    const channel = await input.guild.channels.create({
      name: "world-join",
      type: ChannelType.GuildText,
      parent: parentCategoryId ?? undefined,
      permissionOverwrites: overwrites.join,
      reason: `world join channel ensure W${input.meta.id}`,
    });
    await this.worldStore.setJoinChannelId(input.meta.id, channel.id);
    await this.worldFiles.appendEvent(input.meta.id, {
      type: "world_join_channel_created",
      worldId: input.meta.id,
      guildId: input.meta.homeGuildId,
      joinChannelId: channel.id,
    });
    return channel.id;
  }

  private async inferWorldIdFromWorldSubspace(
    interaction: ChatInputCommandInteraction,
  ): Promise<number | null> {
    const channelId = interaction.channelId?.trim();
    if (!channelId || !interaction.guild) {
      return null;
    }

    const direct = await this.worldStore.getWorldIdByChannel(channelId);
    if (direct) {
      return direct;
    }

    const base = await interaction.guild.channels.fetch(channelId).catch(() => {
      return null;
    });
    if (!base) {
      return null;
    }

    let channel: unknown = base;
    const isThread =
      channel &&
      typeof channel === "object" &&
      "isThread" in channel &&
      typeof (channel as { isThread?: () => boolean }).isThread ===
        "function" &&
      (channel as { isThread: () => boolean }).isThread();
    if (isThread) {
      const parentId = (channel as { parentId?: unknown }).parentId;
      if (typeof parentId === "string" && parentId.trim()) {
        const fetched = await interaction.guild.channels
          .fetch(parentId)
          .catch(() => null);
        if (fetched) {
          channel = fetched;
        }
      }
    }

    const baseChannelId =
      channel &&
      typeof channel === "object" &&
      "id" in channel &&
      typeof (channel as { id?: unknown }).id === "string"
        ? (channel as { id: string }).id
        : channelId;

    const categoryId =
      channel &&
      typeof channel === "object" &&
      "type" in channel &&
      (channel as { type?: unknown }).type === ChannelType.GuildCategory &&
      "id" in channel &&
      typeof (channel as { id?: unknown }).id === "string"
        ? (channel as { id: string }).id
        : (channel as { parentId?: unknown }).parentId;
    if (typeof categoryId !== "string" || !categoryId.trim()) {
      const ids = await this.worldStore.listWorldIds(200);
      for (const id of ids) {
        const meta = await this.worldStore.getWorld(id);
        if (!meta || meta.status === "draft") {
          continue;
        }
        if (meta.joinChannelId && meta.joinChannelId === baseChannelId) {
          return meta.id;
        }
        if (meta.infoChannelId === baseChannelId) {
          return meta.id;
        }
        if (meta.roleplayChannelId === baseChannelId) {
          return meta.id;
        }
        if (meta.proposalsChannelId === baseChannelId) {
          return meta.id;
        }
        if (meta.buildChannelId && meta.buildChannelId === baseChannelId) {
          return meta.id;
        }
        if (meta.voiceChannelId === baseChannelId) {
          return meta.id;
        }
      }
      return null;
    }
    const mapped = await this.worldStore.getWorldIdByCategory(categoryId);
    if (mapped) {
      return mapped;
    }

    const ids = await this.worldStore.listWorldIds(200);
    for (const id of ids) {
      const meta = await this.worldStore.getWorld(id);
      if (
        meta &&
        meta.status !== "draft" &&
        "categoryId" in meta &&
        meta.categoryId === categoryId
      ) {
        await this.worldStore.setCategoryWorldId(categoryId, meta.id);
        return meta.id;
      }
    }
    return null;
  }

  private async resolveBaseChannelId(
    interaction: ChatInputCommandInteraction,
  ): Promise<string | null> {
    const channelId = interaction.channelId?.trim();
    if (!channelId || !interaction.guild) {
      return null;
    }
    const channel = await interaction.guild.channels
      .fetch(channelId)
      .catch(() => null);
    if (!channel) {
      return channelId;
    }
    const isThread =
      "isThread" in channel &&
      typeof (channel as { isThread?: () => boolean }).isThread ===
        "function" &&
      (channel as { isThread: () => boolean }).isThread();
    if (!isThread) {
      return channelId;
    }
    const parentId = (channel as { parentId?: unknown }).parentId;
    return typeof parentId === "string" && parentId.trim()
      ? parentId
      : channelId;
  }

  private async sendLongTextToChannel(input: {
    guildId: string;
    channelId: string;
    content: string;
    traceId?: string;
  }): Promise<void> {
    const botId = this.botUserId?.trim() ?? this.client.user?.id ?? "";
    if (!botId) {
      return;
    }
    const chunks = splitDiscordMessage(input.content, 1800);
    if (chunks.length === 0) {
      return;
    }
    const session: SessionEvent = {
      type: "message",
      platform: "discord",
      selfId: botId,
      userId: botId,
      guildId: input.guildId,
      channelId: input.channelId,
      messageId: `synthetic-channel-send-${Date.now()}`,
      content: "",
      elements: [],
      timestamp: Date.now(),
      extras: {
        traceId: input.traceId,
        synthetic: true,
        commandName: "world.info.snapshot",
        channelId: input.channelId,
        guildId: input.guildId,
        userId: botId,
      },
    };
    for (const chunk of chunks) {
      await this.sendMessage(session, chunk);
    }
  }

  private async pushWorldInfoSnapshot(input: {
    guildId: string;
    worldId: number;
    worldName: string;
    infoChannelId: string;
    joinChannelId?: string;
    traceId?: string;
  }): Promise<void> {
    const nowIso = new Date().toISOString();
    const [card, rules, members, characters] = await Promise.all([
      this.worldFiles.readWorldCard(input.worldId),
      this.worldFiles.readRules(input.worldId),
      this.worldStore.memberCount(input.worldId),
      this.worldStore.characterCount(input.worldId),
    ]);
    const joinHint = input.joinChannelId
      ? `加入：<#${input.joinChannelId}>（执行 /world join）`
      : `加入入口：未配置`;
    const header = [
      `【世界信息】W${input.worldId} ${input.worldName}`,
      `更新时间：${nowIso}`,
      `访客数：${members} 角色数：${characters}`,
      joinHint,
      ``,
    ].join("\n");

    await this.sendLongTextToChannel({
      guildId: input.guildId,
      channelId: input.infoChannelId,
      content: header,
      traceId: input.traceId,
    });
    await this.sendLongTextToChannel({
      guildId: input.guildId,
      channelId: input.infoChannelId,
      content: card?.trim() ? card.trim() : "(世界卡缺失)",
      traceId: input.traceId,
    });
    await this.sendLongTextToChannel({
      guildId: input.guildId,
      channelId: input.infoChannelId,
      content: rules?.trim() ? rules.trim() : "(规则缺失)",
      traceId: input.traceId,
    });
  }

  private async createWorldSubspace(input: {
    guild: ChatInputCommandInteraction["guild"];
    worldId: number;
    worldName: string;
    creatorUserId: string;
  }): Promise<{
    roleId: string;
    categoryId: string;
    infoChannelId: string;
    joinChannelId: string;
    roleplayChannelId: string;
    proposalsChannelId: string;
    voiceChannelId: string;
    buildChannelId: string;
  }> {
    if (!input.guild) {
      throw new Error("guild is required");
    }

    const role = await input.guild.roles.create({
      name: `World-${input.worldId}`,
      reason: `world publish by ${input.creatorUserId}`,
    });
    const category = await input.guild.channels.create({
      name: `[W${input.worldId}] ${input.worldName}`,
      type: ChannelType.GuildCategory,
      reason: `world publish by ${input.creatorUserId}`,
    });

    const botId = this.botUserId ?? "";
    const baseOverwrites = buildWorldBaseOverwrites({
      everyoneRoleId: input.guild.roles.everyone.id,
      worldRoleId: role.id,
      botUserId: botId,
    });

    const infoChannel = await input.guild.channels.create({
      name: "world-info",
      type: ChannelType.GuildText,
      parent: category.id,
      permissionOverwrites: baseOverwrites.info,
      reason: `world publish by ${input.creatorUserId}`,
    });
    const joinChannel = await input.guild.channels.create({
      name: "world-join",
      type: ChannelType.GuildText,
      parent: category.id,
      permissionOverwrites: baseOverwrites.join,
      reason: `world publish by ${input.creatorUserId}`,
    });
    const roleplayChannel = await input.guild.channels.create({
      name: "world-roleplay",
      type: ChannelType.GuildText,
      parent: category.id,
      permissionOverwrites: baseOverwrites.roleplay,
      reason: `world publish by ${input.creatorUserId}`,
    });
    const buildChannel = await input.guild.channels.create({
      name: "world-build",
      type: ChannelType.GuildText,
      parent: category.id,
      permissionOverwrites: buildCreatorOnlyOverwrites({
        everyoneRoleId: input.guild.roles.everyone.id,
        worldRoleId: role.id,
        creatorUserId: input.creatorUserId,
        botUserId: botId,
      }),
      reason: `world publish by ${input.creatorUserId}`,
    });
    const proposalsChannel = await input.guild.channels.create({
      name: "world-proposals",
      type: ChannelType.GuildText,
      parent: category.id,
      permissionOverwrites: baseOverwrites.proposals,
      reason: `world publish by ${input.creatorUserId}`,
    });
    const voiceChannel = await input.guild.channels.create({
      name: "World Voice",
      type: ChannelType.GuildVoice,
      parent: category.id,
      permissionOverwrites: baseOverwrites.voice,
      reason: `world publish by ${input.creatorUserId}`,
    });

    await this.worldFiles.appendEvent(input.worldId, {
      type: "world_subspace_created",
      worldId: input.worldId,
      guildId: input.guild.id,
      userId: input.creatorUserId,
      roleId: role.id,
      categoryId: category.id,
      infoChannelId: infoChannel.id,
      joinChannelId: joinChannel.id,
      roleplayChannelId: roleplayChannel.id,
      proposalsChannelId: proposalsChannel.id,
      voiceChannelId: voiceChannel.id,
      buildChannelId: buildChannel.id,
    });

    return {
      roleId: role.id,
      categoryId: category.id,
      infoChannelId: infoChannel.id,
      joinChannelId: joinChannel.id,
      roleplayChannelId: roleplayChannel.id,
      proposalsChannelId: proposalsChannel.id,
      voiceChannelId: voiceChannel.id,
      buildChannelId: buildChannel.id,
    };
  }

  private async ensureWorldGroupAgent(input: {
    worldId: number;
    worldName: string;
  }): Promise<void> {
    const groupId = buildWorldGroupId(input.worldId);
    const groupPath = await this.groupRepository.ensureGroupDir(groupId);
    const agentPath = path.join(groupPath, "agent.md");
    const content = buildWorldAgentPrompt(input);
    await atomicWrite(agentPath, content);
  }

  private async ensureWorldBuildGroupAgent(input: {
    worldId: number;
    worldName: string;
  }): Promise<void> {
    const groupId = buildWorldBuildGroupId(input.worldId);
    const groupPath = await this.groupRepository.ensureGroupDir(groupId);
    const agentPath = path.join(groupPath, "agent.md");
    const content = buildWorldBuildAgentPrompt(input);
    await atomicWrite(agentPath, content);
  }

  private async ensureCharacterBuildGroupAgent(input: {
    worldId: number;
    worldName: string;
    characterId: number;
    characterName: string;
  }): Promise<void> {
    const groupId = buildWorldCharacterBuildGroupId(
      input.worldId,
      input.characterId,
    );
    const groupPath = await this.groupRepository.ensureGroupDir(groupId);
    const agentPath = path.join(groupPath, "agent.md");
    const content = buildCharacterBuildAgentPrompt(input);
    await atomicWrite(agentPath, content);
  }

  private async emitSyntheticWorldBuildKickoff(input: {
    guildId: string;
    channelId: string;
    userId: string;
    worldId: number;
    worldName: string;
    traceId?: string;
  }): Promise<void> {
    if (this.listenerCount("event") === 0) {
      return;
    }
    const botId = this.botUserId?.trim() ?? "";
    if (!botId) {
      return;
    }
    const content = [
      `你现在在世界构建/编辑模式。`,
      `请先读取 world/source.md，然后用技能 world-design-card 规范化并更新：`,
      `- world/world-card.md（世界卡）`,
      `- world/rules.md（底层规则，如初始金额/装备等）`,
      ``,
      `要求：`,
      `1) 必须通过工具写入/编辑文件，不能只在聊天里输出。`,
      `2) 回复包含：变更摘要 +（如信息不足）3-5 个需要创作者补充的问题；如果信息已足够则明确说明“已 OK，可发布/可关闭”。`,
      `3) 不要 roleplay，不要编造未给出的设定。`,
      ``,
      `提示：创作者完成后在话题中执行 /world done（草稿会发布；已发布世界则仅关闭话题）。`,
      ``,
      `世界：W${input.worldId} ${input.worldName}`,
    ].join("\n");

    const messageId = `synthetic-world-build-${Date.now()}-${Math.random()
      .toString(16)
      .slice(2)}`;
    await this.emitEvent({
      type: "message",
      platform: "discord",
      selfId: botId,
      userId: input.userId,
      guildId: input.guildId,
      channelId: input.channelId,
      messageId,
      content,
      elements: [{ type: "text", text: content }],
      timestamp: Date.now(),
      extras: {
        traceId: input.traceId,
        synthetic: true,
        interactionId: messageId,
        commandName: "world.create.kickoff",
        channelId: input.channelId,
        guildId: input.guildId,
        userId: input.userId,
      },
    } satisfies SessionEvent<DiscordInteractionExtras>);
  }

  private async emitSyntheticCharacterBuildKickoff(input: {
    guildId: string;
    channelId: string;
    userId: string;
    worldId: number;
    worldName: string;
    characterId: number;
    characterName: string;
    traceId?: string;
  }): Promise<void> {
    if (this.listenerCount("event") === 0) {
      return;
    }
    const botId = this.botUserId?.trim() ?? "";
    if (!botId) {
      return;
    }

    const content = [
      `你现在在角色卡构建模式。`,
      `请读取并对齐：`,
      `- world/world-card.md（世界卡，只读）`,
      `- world/rules.md（世界规则，只读）`,
      `- world/character-card.md（本角色卡，可写）`,
      ``,
      `请使用技能 character-card 完善并更新 world/character-card.md。`,
      ``,
      `要求：`,
      `1) 必须通过工具写入/编辑文件，不能只在聊天里输出。`,
      `2) 禁止修改 world/world-card.md 与 world/rules.md（它们只读）。`,
      `3) 回复包含：变更摘要 +（如信息不足）3-5 个需要创作者补充的问题；如果信息已足够则明确说明“已 OK”，并提醒创作者执行 /character close。`,
      ``,
      `角色：C${input.characterId} ${input.characterName}`,
      `世界：W${input.worldId} ${input.worldName}`,
    ].join("\n");

    const messageId = `synthetic-character-build-${Date.now()}-${Math.random()
      .toString(16)
      .slice(2)}`;
    await this.emitEvent({
      type: "message",
      platform: "discord",
      selfId: botId,
      userId: input.userId,
      guildId: input.guildId,
      channelId: input.channelId,
      messageId,
      content,
      elements: [{ type: "text", text: content }],
      timestamp: Date.now(),
      extras: {
        traceId: input.traceId,
        synthetic: true,
        interactionId: messageId,
        commandName: "character.create.kickoff",
        channelId: input.channelId,
        guildId: input.guildId,
        userId: input.userId,
      },
    } satisfies SessionEvent<DiscordInteractionExtras>);
  }

  private async registerSlashCommands(): Promise<void> {
    const applicationId =
      this.applicationId ?? this.client.application?.id ?? null;
    if (!applicationId) {
      this.logger.warn("Missing Discord application id; skip slash commands");
      return;
    }

    const commands = buildSlashCommands();
    const rest = new REST({ version: "10" }).setToken(this.token);

    const guildIds = this.client.guilds.cache.map((guild) => guild.id);
    if (guildIds.length === 0) {
      try {
        await rest.put(Routes.applicationCommands(applicationId), {
          body: commands,
        });
        this.logger.info({ applicationId }, "Registered global slash commands");
      } catch (err) {
        this.logger.warn(
          { err, applicationId },
          "Failed to register global commands",
        );
      }
      return;
    }

    await Promise.allSettled(
      guildIds.map(async (guildId) => {
        try {
          await rest.put(
            Routes.applicationGuildCommands(applicationId, guildId),
            {
              body: commands,
            },
          );
          this.logger.info(
            { applicationId, guildId },
            "Registered guild slash commands",
          );
        } catch (err) {
          this.logger.warn(
            { err, applicationId, guildId },
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
      .setName("reset")
      .setDescription("重置对话（创建新的 session）")
      .addIntegerOption((option) =>
        option
          .setName("key")
          .setDescription("会话槽位（默认 0）")
          .setMinValue(0)
          .setRequired(false),
      )
      .addUserOption((option) =>
        option
          .setName("user")
          .setDescription("要重置的用户（默认自己；仅管理员可指定他人）")
          .setRequired(false),
      )
      .toJSON(),
    new SlashCommandBuilder()
      .setName("resetall")
      .setDescription("重置全群对话（仅管理员）")
      .addIntegerOption((option) =>
        option
          .setName("key")
          .setDescription("会话槽位（默认 0）")
          .setMinValue(0)
          .setRequired(false),
      )
      .toJSON(),
    new SlashCommandBuilder()
      .setName("model")
      .setDescription("切换群模型（仅管理员）")
      .addStringOption((option) =>
        option
          .setName("name")
          .setDescription(
            "模型 ID（必须在 OPENCODE_MODELS 白名单内；允许包含 `/`；default 清除覆盖）",
          )
          .setRequired(true),
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
    new SlashCommandBuilder()
      .setName("world")
      .setDescription("世界系统")
      .addSubcommand((sub) =>
        sub
          .setName("create")
          .setDescription(
            "创建世界（会创建私密话题多轮补全，/world done 后发布）",
          )
          .addStringOption((option) =>
            option
              .setName("name")
              .setDescription("世界名称（可留空，后续在子话题里补全）")
              .setRequired(false),
          )
          .addStringOption((option) =>
            option
              .setName("message")
              .setDescription("设定摘要/初始设定（可选；长文建议用 document）")
              .setMinLength(1)
              .setMaxLength(4000)
              .setRequired(false),
          )
          .addAttachmentOption((option) =>
            option
              .setName("document")
              .setDescription("设定文档（txt/md/docx，建议 <= 1MB）")
              .setRequired(false),
          ),
      )
      .addSubcommand((sub) =>
        sub.setName("help").setDescription("查看世界系统指令用法"),
      )
      .addSubcommand((sub) =>
        sub
          .setName("list")
          .setDescription("列出世界（全局）")
          .addIntegerOption((option) =>
            option
              .setName("limit")
              .setDescription("条数（默认 20）")
              .setMinValue(1)
              .setMaxValue(100)
              .setRequired(false),
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName("info")
          .setDescription("查看世界卡")
          .addIntegerOption((option) =>
            option
              .setName("world_id")
              .setDescription("世界ID")
              .setMinValue(1)
              .setRequired(true),
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName("rules")
          .setDescription("查看世界规则")
          .addIntegerOption((option) =>
            option
              .setName("world_id")
              .setDescription("世界ID")
              .setMinValue(1)
              .setRequired(true),
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName("canon")
          .setDescription("搜索本世界正典（世界卡/规则）")
          .addStringOption((option) =>
            option
              .setName("query")
              .setDescription("关键词")
              .setMinLength(1)
              .setMaxLength(100)
              .setRequired(true),
          )
          .addIntegerOption((option) =>
            option
              .setName("world_id")
              .setDescription("世界ID（在世界入口频道内可省略）")
              .setMinValue(1)
              .setRequired(false),
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName("join")
          .setDescription("加入世界（仅在 world-join 频道执行）"),
      )
      .addSubcommand((sub) =>
        sub
          .setName("stats")
          .setDescription("查看世界统计")
          .addIntegerOption((option) =>
            option
              .setName("world_id")
              .setDescription("世界ID")
              .setMinValue(1)
              .setRequired(true),
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName("status")
          .setDescription("查看世界状态（同 stats）")
          .addIntegerOption((option) =>
            option
              .setName("world_id")
              .setDescription("世界ID")
              .setMinValue(1)
              .setRequired(true),
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName("search")
          .setDescription("搜索世界（按名称/世界卡/规则）")
          .addStringOption((option) =>
            option
              .setName("query")
              .setDescription("关键词")
              .setMinLength(1)
              .setMaxLength(100)
              .setRequired(true),
          )
          .addIntegerOption((option) =>
            option
              .setName("limit")
              .setDescription("条数（默认 10）")
              .setMinValue(1)
              .setMaxValue(50)
              .setRequired(false),
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName("edit")
          .setDescription("创建一个世界编辑话题（仅创作者）")
          .addIntegerOption((option) =>
            option
              .setName("world_id")
              .setDescription("世界ID")
              .setMinValue(1)
              .setRequired(true),
          )
          .addStringOption((option) =>
            option
              .setName("message")
              .setDescription("补充说明/变更目标（可选）")
              .setMinLength(1)
              .setMaxLength(2000)
              .setRequired(false),
          )
          .addAttachmentOption((option) =>
            option
              .setName("document")
              .setDescription(
                "补充设定文档（txt/md/docx，可选，会写入 world/source.md）",
              )
              .setRequired(false),
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName("done")
          .setDescription("结束当前世界构建/编辑话题（仅创作者）"),
      )
      .toJSON(),
    new SlashCommandBuilder()
      .setName("character")
      .setDescription("角色系统")
      .addSubcommand((sub) =>
        sub
          .setName("create")
          .setDescription("创建角色卡（需已加入世界）")
          .addStringOption((option) =>
            option.setName("name").setDescription("角色名").setRequired(true),
          )
          .addIntegerOption((option) =>
            option
              .setName("world_id")
              .setDescription("世界ID（在世界入口频道内可省略）")
              .setMinValue(1)
              .setRequired(false),
          )
          .addStringOption((option) =>
            option
              .setName("visibility")
              .setDescription("可见性（默认 world）")
              .addChoices(
                { name: "world", value: "world" },
                { name: "public", value: "public" },
                { name: "private", value: "private" },
              )
              .setRequired(false),
          )
          .addStringOption((option) =>
            option
              .setName("description")
              .setDescription("补充描述（可选）")
              .setRequired(false),
          ),
      )
      .addSubcommand((sub) =>
        sub.setName("help").setDescription("查看角色系统指令用法"),
      )
      .addSubcommand((sub) =>
        sub
          .setName("view")
          .setDescription("查看角色卡")
          .addIntegerOption((option) =>
            option
              .setName("character_id")
              .setDescription("角色ID")
              .setMinValue(1)
              .setRequired(true),
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName("act")
          .setDescription("指定 bot 在本世界扮演哪个角色")
          .addIntegerOption((option) =>
            option
              .setName("character_id")
              .setDescription("角色ID")
              .setMinValue(1)
              .setRequired(true),
          ),
      )
      .addSubcommand((sub) =>
        sub.setName("close").setDescription("关闭当前角色构建话题（仅创作者）"),
      )
      .toJSON(),
  ];
}

function buildWorldBaseOverwrites(input: {
  everyoneRoleId: string;
  worldRoleId: string;
  botUserId: string;
}): {
  info: Array<{ id: string; allow?: bigint[]; deny?: bigint[] }>;
  join: Array<{ id: string; allow?: bigint[]; deny?: bigint[] }>;
  roleplay: Array<{ id: string; allow?: bigint[]; deny?: bigint[] }>;
  proposals: Array<{ id: string; allow?: bigint[]; deny?: bigint[] }>;
  voice: Array<{ id: string; allow?: bigint[]; deny?: bigint[] }>;
} {
  const view = PermissionFlagsBits.ViewChannel;
  const readHistory = PermissionFlagsBits.ReadMessageHistory;
  const send = PermissionFlagsBits.SendMessages;
  const sendInThreads = PermissionFlagsBits.SendMessagesInThreads;
  const createPrivateThreads = PermissionFlagsBits.CreatePrivateThreads;
  const connect = PermissionFlagsBits.Connect;
  const speak = PermissionFlagsBits.Speak;

  const allowBot =
    input.botUserId && input.botUserId.trim()
      ? [
          {
            id: input.botUserId,
            allow: [
              view,
              readHistory,
              send,
              sendInThreads,
              createPrivateThreads,
            ],
          },
        ]
      : [];

  const everyoneReadOnly = {
    id: input.everyoneRoleId,
    allow: [view, readHistory],
    deny: [send],
  };
  const everyoneWritable = {
    id: input.everyoneRoleId,
    allow: [view, readHistory, send],
  };
  const everyoneHidden = {
    id: input.everyoneRoleId,
    deny: [view],
  };
  const worldReadOnly = {
    id: input.worldRoleId,
    allow: [view, readHistory],
    deny: [send],
  };
  const worldWritable = {
    id: input.worldRoleId,
    allow: [view, readHistory, send, sendInThreads],
  };

  return {
    info: [everyoneReadOnly, worldReadOnly, ...allowBot],
    join: [everyoneWritable, worldWritable, ...allowBot],
    roleplay: [everyoneHidden, worldWritable, ...allowBot],
    proposals: [everyoneHidden, worldWritable, ...allowBot],
    voice: [
      { id: input.everyoneRoleId, deny: [view, connect] },
      { id: input.worldRoleId, allow: [view, connect, speak] },
    ],
  };
}

function buildCreatorOnlyOverwrites(input: {
  everyoneRoleId: string;
  worldRoleId: string;
  creatorUserId: string;
  botUserId: string;
}): Array<{ id: string; allow?: bigint[]; deny?: bigint[] }> {
  const view = PermissionFlagsBits.ViewChannel;
  const readHistory = PermissionFlagsBits.ReadMessageHistory;
  const send = PermissionFlagsBits.SendMessages;
  const sendInThreads = PermissionFlagsBits.SendMessagesInThreads;
  const createPrivateThreads = PermissionFlagsBits.CreatePrivateThreads;

  const allowBot =
    input.botUserId && input.botUserId.trim()
      ? [
          {
            id: input.botUserId,
            allow: [
              view,
              readHistory,
              send,
              sendInThreads,
              createPrivateThreads,
            ],
          },
        ]
      : [];

  return [
    { id: input.everyoneRoleId, deny: [view] },
    { id: input.worldRoleId, deny: [view] },
    {
      id: input.creatorUserId,
      allow: [view, readHistory, send, sendInThreads],
    },
    ...allowBot,
  ];
}

function buildDraftCreatorOnlyOverwrites(input: {
  everyoneRoleId: string;
  creatorUserId: string;
  botUserId: string;
}): Array<{ id: string; allow?: bigint[]; deny?: bigint[] }> {
  const view = PermissionFlagsBits.ViewChannel;
  const readHistory = PermissionFlagsBits.ReadMessageHistory;
  const send = PermissionFlagsBits.SendMessages;
  const sendInThreads = PermissionFlagsBits.SendMessagesInThreads;
  const createPrivateThreads = PermissionFlagsBits.CreatePrivateThreads;

  const allowBot =
    input.botUserId && input.botUserId.trim()
      ? [
          {
            id: input.botUserId,
            allow: [
              view,
              readHistory,
              send,
              sendInThreads,
              createPrivateThreads,
            ],
          },
        ]
      : [];

  return [
    { id: input.everyoneRoleId, deny: [view] },
    {
      id: input.creatorUserId,
      allow: [view, readHistory, send, sendInThreads],
    },
    ...allowBot,
  ];
}

function buildWorldAgentPrompt(input: {
  worldId: number;
  worldName: string;
}): string {
  return [
    `---`,
    `name: World-${input.worldId}`,
    `version: 1`,
    `---`,
    ``,
    `你在 Discord 世界系统中工作。当前世界：W${input.worldId} ${input.worldName}。`,
    ``,
    `硬性规则：`,
    `1) 世界正典与规则在会话工作区的 \`world/world-card.md\` 与 \`world/rules.md\`。回答前必须读取它们；不确定就说不知道，禁止编造。`,
    `2) 如果 \`world/active-character.md\` 存在：你必须以其中角色口吻进行对话（用户通过 /character act 设置）。否则你作为旁白/世界系统。`,
    `3) 当前是游玩会话（只读）。当用户请求修改世界设定/正典时：不要直接改写文件；应引导联系世界创作者使用 /world edit。`,
    ``,
  ].join("\n");
}

function buildWorldBuildAgentPrompt(input: {
  worldId: number;
  worldName: string;
}): string {
  return [
    `---`,
    `name: World-${input.worldId}-Build`,
    `version: 1`,
    `---`,
    ``,
    `你在 Discord 世界系统中工作，当前是“世界创作/整理”模式：W${input.worldId} ${input.worldName}。`,
    ``,
    `目标：把创作者上传的设定文档规范化为可用的“世界卡 + 世界规则”，并持续补全。`,
    ``,
    `硬性规则：`,
    `1) 设定原文在会话工作区的 \`world/source.md\`。`,
    `2) 规范化后的产物必须写入：\`world/world-card.md\` 与 \`world/rules.md\`。你必须使用工具写入/编辑文件，禁止只在回复里输出。`,
    `3) 每次回复都包含：变更摘要 +（如信息不足）3-5 个需要创作者补充的问题；如果信息已足够则明确说明“已 OK”，并提醒创作者执行 /world done。`,
    `4) 你不是来写小说的，不要 roleplay。`,
    ``,
    `提示：你可以使用技能 \`world-design-card\` 来统一模板与字段。`,
    ``,
  ].join("\n");
}

function buildCharacterBuildAgentPrompt(input: {
  worldId: number;
  worldName: string;
  characterId: number;
  characterName: string;
}): string {
  return [
    `---`,
    `name: World-${input.worldId}-Character-${input.characterId}-Build`,
    `version: 1`,
    `---`,
    ``,
    `你在 Discord 世界系统中工作，当前是“角色卡创作/整理”模式：`,
    `- 世界：W${input.worldId} ${input.worldName}`,
    `- 角色：C${input.characterId} ${input.characterName}`,
    ``,
    `目标：把角色设定规范化为可用的角色卡，并持续补全。`,
    ``,
    `硬性规则：`,
    `1) 世界正典在 \`world/world-card.md\` 与 \`world/rules.md\`（只读）。回答前必须读取它们；不确定就说不知道，禁止编造。`,
    `2) 角色卡产物必须写入：\`world/character-card.md\`。你必须使用工具写入/编辑文件，禁止只在回复里输出。`,
    `3) 禁止修改 \`world/world-card.md\` 与 \`world/rules.md\`（你写了也不会被保存）。`,
    `4) 每次回复都包含：变更摘要 +（如信息不足）3-5 个需要创作者补充的问题；如果信息已足够则明确说明“已 OK”，并提醒创作者执行 /character close。`,
    `5) 你不是来写小说的，不要 roleplay。`,
    ``,
    `提示：你可以使用技能 \`character-card\` 来统一模板与字段。`,
    ``,
  ].join("\n");
}

function buildDefaultCharacterCard(input: {
  worldId: number;
  worldName: string;
  characterId: number;
  name: string;
  creatorId: string;
  description: string;
}): string {
  const extra = input.description.trim();
  return [
    `# 角色卡（C${input.characterId}）`,
    ``,
    `- 角色名：${input.name}`,
    `- 所属世界：W${input.worldId} ${input.worldName}`,
    `- 创建者：${input.creatorId}`,
    extra ? `- 补充：${extra}` : `- 补充：`,
    ``,
    `## 外貌`,
    `- 整体印象：`,
    `- 发型发色：`,
    `- 眼睛：`,
    `- 体型身高：`,
    ``,
    `## 性格`,
    `- 核心性格：`,
    `- 说话风格：`,
    ``,
    `## 背景`,
    `- 出身背景：`,
    `- 关键经历：`,
    `- 当前状态：`,
    ``,
  ].join("\n");
}

function extractWorldNameFromCard(card: string | null): string | null {
  const raw = card?.trim();
  if (!raw) {
    return null;
  }
  for (const line of raw.split("\n")) {
    const bullet = line.match(/^\s*-\s*世界名称[:：]\s*(.+)\s*$/);
    if (bullet?.[1]) {
      const value = bullet[1].trim();
      if (value && value !== "无" && value !== "N/A") {
        return value;
      }
    }
    const table = line.match(/^\s*\|\s*世界名称\s*\|\s*(.+?)\s*\|/);
    if (table?.[1]) {
      const value = table[1].trim();
      if (value && value !== "无" && value !== "N/A") {
        return value;
      }
    }
  }
  return null;
}

async function replyLongText(
  interaction: ChatInputCommandInteraction,
  content: string,
  options: { ephemeral: boolean },
): Promise<void> {
  const chunks = splitDiscordMessage(content, 1800);
  const first = chunks.shift();
  if (!first) {
    await safeReply(interaction, "(空)", options);
    return;
  }
  await safeReply(interaction, first, options);
  for (const chunk of chunks) {
    await safeReply(interaction, chunk, options);
  }
}

function splitDiscordMessage(input: string, maxLen: number): string[] {
  const normalized = input.trim();
  if (!normalized) {
    return [];
  }
  const chunks: string[] = [];
  let remaining = normalized;
  while (remaining.length > maxLen) {
    const slice = remaining.slice(0, maxLen);
    const lastNewline = slice.lastIndexOf("\n");
    const splitAt = lastNewline > 400 ? lastNewline : maxLen;
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).trimStart();
  }
  if (remaining) {
    chunks.push(remaining);
  }
  return chunks;
}

async function atomicWrite(filePath: string, content: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tmpPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`,
  );
  await writeFile(
    tmpPath,
    content.endsWith("\n") ? content : `${content}\n`,
    "utf8",
  );
  await rename(tmpPath, filePath);
}

async function safeReply(
  interaction: ChatInputCommandInteraction,
  content: string,
  options: { ephemeral: boolean },
): Promise<void> {
  feishuLogJson({
    event: "discord.command.reply",
    command: buildInteractionCommand(interaction),
    interactionId: interaction.id,
    userId: interaction.user.id,
    guildId: interaction.guildId ?? undefined,
    channelId: interaction.channelId,
    ephemeral: options.ephemeral,
    contentPreview: previewTextForLog(content, 1200),
    contentLength: content.length,
  });
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

function buildInteractionCommand(
  interaction: ChatInputCommandInteraction,
): string {
  const base = `/${interaction.commandName}`;
  try {
    const group = interaction.options.getSubcommandGroup(false)?.trim() ?? "";
    const sub = interaction.options.getSubcommand(false)?.trim() ?? "";
    const parts = [base, group, sub].filter(Boolean);
    return parts.join(" ");
  } catch {
    return base;
  }
}

function previewTextForLog(text: string, maxBytes: number): string {
  const trimmed = redactSensitiveText(String(text ?? "")).trim();
  if (!trimmed) {
    return "";
  }
  if (maxBytes <= 0) {
    return "";
  }
  const buffer = Buffer.from(trimmed, "utf8");
  if (buffer.byteLength <= maxBytes) {
    return trimmed;
  }
  const sliced = buffer.toString("utf8", 0, maxBytes);
  return `${sliced}\n\n[truncated]`;
}
