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
  type Guild,
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
import { WorldStore, type CharacterVisibility } from "../../world/store";
import { WorldFileStore } from "../../world/file-store";
import {
  buildWorldBuildGroupId,
  buildWorldGroupId,
  parseWorldGroup,
} from "../../world/ids";
import {
  buildCharacterBuildGroupId,
  buildWorldCharacterBuildGroupId,
  parseCharacterGroup,
} from "../../character/ids";
import { getConfig } from "../../config";
import { feishuLogJson } from "../../feishu/webhook";
import { GroupFileRepository } from "../../store/repository";
import { fetchDiscordTextAttachment } from "./text-attachments";
import path from "node:path";
import { writeFile, mkdir, rename, rm } from "node:fs/promises";
import { createTraceId } from "../../telemetry";
import { redactSensitiveText } from "../../utils/redact";
import { UserStateStore, type UserRole } from "../../user/state-store";

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
  private userState: UserStateStore;

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
    this.userState = new UserStateStore({ logger: this.logger });

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
      if (this.slashCommandsEnabled) {
        void this.migrateWorldSubspaceChannels().catch((err) => {
          this.logger.warn({ err }, "World subspace channel migration failed");
        });
        void this.migrateWorldAgents().catch((err) => {
          this.logger.warn({ err }, "World agent migration failed");
        });
      }
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
      feishuLogJson({
        event: "io.recv",
        platform: parsed.platform,
        guildId: parsed.guildId,
        channelId: parsed.channelId,
        userId: parsed.userId,
        messageId: parsed.messageId,
        contentPreview: previewTextForLog(parsed.content ?? "", 1200),
        contentLength: parsed.content?.length ?? 0,
        hasAttachments: Boolean(
          message.attachments && message.attachments.size,
        ),
      });
      try {
        await this.repairWorldChannelRouting(message);
      } catch (err) {
        this.logger.warn({ err }, "Failed to repair world channel routing");
      }
      try {
        await this.maybePromptOnboarding(message);
      } catch (err) {
        this.logger.warn({ err }, "Failed to send onboarding prompt");
      }
      try {
        await this.ingestWorldBuildAttachments(message, parsed);
      } catch (err) {
        this.logger.warn({ err }, "Failed to ingest world build attachments");
      }
      try {
        const blocked = await this.maybeRejectWorldPlayMessageNotMember(
          message,
          parsed,
        );
        if (blocked) {
          return;
        }
      } catch (err) {
        this.logger.warn({ err }, "Failed to check world membership");
      }
      this.logger.debug({ messageId: parsed.messageId }, "Message received");
      await this.emitEvent(parsed);
    } catch (err) {
      this.logger.error({ err }, "Failed to handle Discord message");
    }
  }

  private async maybeRejectWorldPlayMessageNotMember(
    message: Message,
    session: SessionEvent<DiscordMessageExtras>,
  ): Promise<boolean> {
    if (!message.guildId) {
      return false;
    }
    const botId = this.botUserId ?? this.client.user?.id ?? "";
    if (!botId) {
      return false;
    }

    const mentionedBot = session.elements.some(
      (element) => element.type === "mention" && element.userId === botId,
    );
    if (!mentionedBot) {
      return false;
    }

    const groupId = await this.worldStore
      .getGroupIdByChannel(message.channelId)
      .catch(() => null);
    const parsed = groupId ? parseWorldGroup(groupId) : null;
    if (!parsed || parsed.kind !== "play") {
      return false;
    }

    const isMember =
      (await this.worldStore
        .isMember(parsed.worldId, message.author.id)
        .catch(() => false)) ||
      (await this.worldFiles
        .hasMember(parsed.worldId, message.author.id)
        .catch(() => false));
    if (isMember) {
      return false;
    }

    const meta = await this.worldStore.getWorld(parsed.worldId);
    if (!meta || meta.status !== "active") {
      return false;
    }

    await this.sendMessage(
      session,
      `你还未加入该世界：W${meta.id} ${meta.name}\n请先加入：/world join world_id:${meta.id}`,
    );
    return true;
  }

  private async repairWorldChannelRouting(message: Message): Promise<void> {
    if (!message.guildId) {
      return;
    }
    const channelId = message.channelId?.trim();
    if (!channelId) {
      return;
    }

    const existingGroupId = await this.worldStore
      .getGroupIdByChannel(channelId)
      .catch(() => null);
    const existingWorldId = await this.worldStore
      .getWorldIdByChannel(channelId)
      .catch(() => null);
    if (existingGroupId || existingWorldId) {
      return;
    }

    const channel = message.channel as unknown;
    const channelName =
      channel &&
      typeof channel === "object" &&
      "name" in channel &&
      typeof (channel as { name?: unknown }).name === "string"
        ? ((channel as { name: string }).name as string).trim()
        : "";

    const isThread =
      channel &&
      typeof channel === "object" &&
      "isThread" in channel &&
      typeof (channel as { isThread?: () => boolean }).isThread ===
        "function" &&
      (channel as { isThread: () => boolean }).isThread();

    const inferWorldIdFromWorldLabel = (label: string): number | null => {
      const match = label.match(/\bW(\d+)\b/);
      if (!match) {
        return null;
      }
      const parsed = Number(match[1]);
      return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
    };

    // 1) Thread name heuristics: "世界创建 W1" / "世界编辑 W1"
    if (isThread && channelName) {
      const worldIdFromThread =
        channelName.includes("世界创建") || channelName.includes("世界编辑")
          ? inferWorldIdFromWorldLabel(channelName)
          : null;
      if (worldIdFromThread) {
        const meta = await this.worldStore.getWorld(worldIdFromThread);
        if (meta) {
          await this.worldStore.setChannelWorldId(channelId, meta.id);
          await this.worldStore.setChannelGroupId(
            channelId,
            buildWorldBuildGroupId(meta.id),
          );
          await this.ensureWorldBuildGroupAgent({
            worldId: meta.id,
            worldName: meta.name,
          });
          await this.worldFiles.appendEvent(meta.id, {
            type: "world_build_routing_repaired",
            worldId: meta.id,
            guildId: message.guildId,
            channelId,
            via: "thread_name",
          });
        }
        return;
      }
    }

    // 2) Creator-only text channel fallback: world-build-w{n} / world-edit-w{n}
    if (channelName) {
      const channelWorldId =
        channelName.startsWith("world-build-w") ||
        channelName.startsWith("world-edit-w")
          ? inferWorldIdFromWorldLabel(
              channelName.replace(/-/g, " ").toUpperCase(),
            )
          : null;
      if (channelWorldId) {
        const meta = await this.worldStore.getWorld(channelWorldId);
        if (meta) {
          await this.worldStore.setChannelWorldId(channelId, meta.id);
          await this.worldStore.setChannelGroupId(
            channelId,
            buildWorldBuildGroupId(meta.id),
          );
          await this.ensureWorldBuildGroupAgent({
            worldId: meta.id,
            worldName: meta.name,
          });
          await this.worldFiles.appendEvent(meta.id, {
            type: "world_build_routing_repaired",
            worldId: meta.id,
            guildId: message.guildId,
            channelId,
            via: "channel_name",
          });
        }
        return;
      }
    }

    // 3) Category-based inference: world-build / world-join / world-announcements etc.
    const parentId =
      channel &&
      typeof channel === "object" &&
      "parentId" in channel &&
      typeof (channel as { parentId?: unknown }).parentId === "string"
        ? ((channel as { parentId: string }).parentId as string).trim()
        : "";
    if (!parentId) {
      return;
    }
    const worldIdFromCategory =
      await this.worldStore.getWorldIdByCategory(parentId);
    if (!worldIdFromCategory) {
      return;
    }

    await this.worldStore.setChannelWorldId(channelId, worldIdFromCategory);

    if (channelName === "world-build") {
      const meta = await this.worldStore.getWorld(worldIdFromCategory);
      if (!meta) {
        return;
      }
      await this.worldStore.setChannelGroupId(
        channelId,
        buildWorldBuildGroupId(meta.id),
      );
      await this.ensureWorldBuildGroupAgent({
        worldId: meta.id,
        worldName: meta.name,
      });
      await this.worldFiles.appendEvent(meta.id, {
        type: "world_build_routing_repaired",
        worldId: meta.id,
        guildId: message.guildId,
        channelId,
        via: "category_parent",
      });
    }
  }

  private async maybePromptOnboarding(message: Message): Promise<void> {
    const config = getConfig();
    const homeGuildId = config.DISCORD_HOME_GUILD_ID?.trim();
    if (!homeGuildId) {
      return;
    }
    if (!message.guildId || message.guildId !== homeGuildId) {
      return;
    }
    if (!message.author?.id) {
      return;
    }

    const existing = await this.userState.read(message.author.id);
    if (existing?.role || existing?.promptedAt) {
      return;
    }
    await this.userState.markPrompted(message.author.id);

    const dm = await this.openDmOrNull(message.author.id);
    if (!dm) {
      return;
    }

    await this.sendLongTextToChannel({
      guildId: undefined,
      channelId: dm.id,
      content: [
        `【新手引导】`,
        `1) 先选择身份（仅需一次）：`,
        `- /onboard role:player`,
        `- /onboard role:creator`,
        ``,
        `提示：/help 查看所有指令。`,
      ].join("\n"),
    });
  }

  private async openDmOrNull(userId: string): Promise<{ id: string } | null> {
    const safe = userId.trim();
    if (!safe) {
      return null;
    }
    const user = await this.client.users.fetch(safe).catch(() => null);
    if (!user) {
      return null;
    }
    const dm = await user.createDM().catch(() => null);
    return dm ? { id: dm.id } : null;
  }

  private async ingestWorldBuildAttachments(
    message: Message,
    session: SessionEvent<DiscordMessageExtras>,
  ): Promise<void> {
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
        `不支持的设定文档类型：${rejected.join(", ")}\n仅支持：txt/md（以及可解析的 docx）`,
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
          "- /onboard role:player|creator",
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
    if (commandName === "onboard") {
      await this.handleOnboard(interaction);
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

  private async handleOnboard(
    interaction: ChatInputCommandInteraction,
  ): Promise<void> {
    const roleRaw = interaction.options.getString("role", true);
    const role: UserRole = roleRaw === "creator" ? "creator" : "player";

    await this.userState.setRole(interaction.user.id, role);

    const dm = await this.openDmOrNull(interaction.user.id);
    if (dm) {
      await this.sendLongTextToChannel({
        channelId: dm.id,
        content: buildRulesText(role),
      });
    }

    await safeReply(
      interaction,
      dm
        ? `已选择身份：${role}。我已私信你规则与下一步指引。`
        : `已选择身份：${role}。但我无法向你发私信（请检查 DM 设置）。`,
      { ephemeral: true },
    );
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
    if (subcommand === "open") {
      const worldId = interaction.options.getInteger("world_id", true);
      await this.handleWorldOpen(interaction, worldId);
      return;
    }
    if (subcommand === "done") {
      await this.handleWorldPublish(interaction);
      return;
    }
    if (subcommand === "list") {
      await this.handleWorldList(interaction);
      return;
    }
    if (subcommand === "info") {
      const worldId =
        interaction.options.getInteger("world_id") ??
        (await this.inferWorldIdFromWorldSubspace(interaction).catch(
          () => null,
        ));
      if (!worldId) {
        await safeReply(
          interaction,
          "缺少 world_id：请在世界子空间频道内执行，或显式提供 world_id。",
          { ephemeral: true },
        );
        return;
      }
      await this.handleWorldInfo(interaction, worldId);
      return;
    }
    if (subcommand === "rules") {
      const worldId =
        interaction.options.getInteger("world_id") ??
        (await this.inferWorldIdFromWorldSubspace(interaction).catch(
          () => null,
        ));
      if (!worldId) {
        await safeReply(
          interaction,
          "缺少 world_id：请在世界子空间频道内执行，或显式提供 world_id。",
          { ephemeral: true },
        );
        return;
      }
      await this.handleWorldRules(interaction, worldId);
      return;
    }
    if (subcommand === "canon") {
      const query = interaction.options.getString("query", true);
      const worldId = interaction.options.getInteger("world_id") ?? undefined;
      await this.handleWorldCanon(interaction, { query, worldId });
      return;
    }
    if (subcommand === "submit") {
      const kind = interaction.options.getString("kind", true) as
        | "canon"
        | "chronicle"
        | "task"
        | "news";
      const title = interaction.options.getString("title", true);
      const content = interaction.options.getString("content", true);
      const worldId =
        interaction.options.getInteger("world_id") ??
        (await this.inferWorldIdFromWorldSubspace(interaction).catch(
          () => null,
        ));
      if (!worldId) {
        await safeReply(
          interaction,
          "缺少 world_id：请在世界子空间频道内执行，或显式提供 world_id。",
          { ephemeral: true },
        );
        return;
      }
      await this.handleWorldSubmit(interaction, {
        worldId,
        kind,
        title,
        content,
      });
      return;
    }
    if (subcommand === "approve") {
      const submissionId = interaction.options.getInteger(
        "submission_id",
        true,
      );
      const worldId =
        interaction.options.getInteger("world_id") ??
        (await this.inferWorldIdFromWorldSubspace(interaction).catch(
          () => null,
        ));
      if (!worldId) {
        await safeReply(
          interaction,
          "缺少 world_id：请在世界子空间频道内执行，或显式提供 world_id。",
          { ephemeral: true },
        );
        return;
      }
      await this.handleWorldApprove(interaction, { worldId, submissionId });
      return;
    }
    if (subcommand === "check") {
      const query = interaction.options.getString("query", true);
      const worldId =
        interaction.options.getInteger("world_id") ??
        (await this.inferWorldIdFromWorldSubspace(interaction).catch(
          () => null,
        ));
      if (!worldId) {
        await safeReply(
          interaction,
          "缺少 world_id：请在世界子空间频道内执行，或显式提供 world_id。",
          { ephemeral: true },
        );
        return;
      }
      await this.handleWorldCheck(interaction, { worldId, query });
      return;
    }
    if (subcommand === "join") {
      const worldId =
        interaction.options.getInteger("world_id") ??
        (await this.inferWorldIdFromWorldSubspace(interaction).catch(
          () => null,
        ));
      if (!worldId) {
        await safeReply(
          interaction,
          "缺少 world_id：请显式提供 world_id（或在目标世界子空间频道内执行 /world join）。",
          { ephemeral: true },
        );
        return;
      }
      const characterId =
        interaction.options.getInteger("character_id") ?? undefined;
      await this.handleWorldJoin(interaction, { worldId, characterId });
      return;
    }
    if (subcommand === "stats") {
      const worldId =
        interaction.options.getInteger("world_id") ??
        (await this.inferWorldIdFromWorldSubspace(interaction).catch(
          () => null,
        ));
      if (!worldId) {
        await safeReply(
          interaction,
          "缺少 world_id：请在世界子空间频道内执行，或显式提供 world_id。",
          { ephemeral: true },
        );
        return;
      }
      await this.handleWorldStats(interaction, worldId);
      return;
    }
    if (subcommand === "status") {
      const worldId =
        interaction.options.getInteger("world_id") ??
        (await this.inferWorldIdFromWorldSubspace(interaction).catch(
          () => null,
        ));
      if (!worldId) {
        await safeReply(
          interaction,
          "缺少 world_id：请在世界子空间频道内执行，或显式提供 world_id。",
          { ephemeral: true },
        );
        return;
      }
      await this.handleWorldStats(interaction, worldId);
      return;
    }
    if (subcommand === "search") {
      const query = interaction.options.getString("query", true);
      const limit = interaction.options.getInteger("limit") ?? undefined;
      await this.handleWorldSearch(interaction, { query, limit });
      return;
    }
    if (subcommand === "remove") {
      const worldId = interaction.options.getInteger("world_id", true);
      await this.handleWorldRemove(interaction, worldId, flags);
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
    const homeGuildId = getConfig().DISCORD_HOME_GUILD_ID?.trim();
    if (homeGuildId && interaction.guildId !== homeGuildId) {
      await safeReply(
        interaction,
        `当前仅允许在 homeGuild 创建世界：guild:${homeGuildId}`,
        { ephemeral: true },
      );
      return;
    }
    const traceId = createTraceId();
    feishuLogJson({
      event: "discord.world.create.start",
      traceId,
      interactionId: interaction.id,
      guildId: interaction.guildId,
      channelId: interaction.channelId,
      userId: interaction.user.id,
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
    await safeDefer(interaction, { ephemeral: true });

    try {
      const nowIso = new Date().toISOString();
      const worldId = await this.worldStore.nextWorldId();
      const worldName = `World-${worldId}`;
      feishuLogJson({
        event: "discord.world.create.draft_id_allocated",
        traceId,
        interactionId: interaction.id,
        worldId,
        worldName,
      });

      const source = {
        filename: "source.md",
        content: [
          `# 设定原文（尚未提供）`,
          ``,
          `请在本话题里继续：`,
          `- 直接粘贴/分段发送你的世界设定原文`,
          `- 或上传 txt/md（以及可解析的 docx）文档（会自动写入 world/source.md）`,
          ``,
          `提示：无需在 /world create 里填写任何参数。`,
          ``,
        ].join("\n"),
      };

      await this.worldStore.createWorldDraft({
        id: worldId,
        homeGuildId: interaction.guildId,
        creatorId: interaction.user.id,
        name: worldName,
        createdAt: nowIso,
        updatedAt: nowIso,
      });
      await this.userState.markWorldCreated(interaction.user.id);

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

      const workshop = await this.createCreatorOnlyChannel({
        guild,
        name: `world-workshop-${interaction.user.id}`,
        creatorUserId: interaction.user.id,
        reason: `world workshop ensure for ${interaction.user.id}`,
      });

      const thread = await this.tryCreatePrivateThread({
        guild,
        parentChannelId: workshop.id,
        name: `世界创建 W${worldId}`,
        reason: `world create W${worldId} by ${interaction.user.id}`,
        memberUserId: interaction.user.id,
      });
      if (!thread) {
        throw new Error(
          "无法创建世界私密话题：请检查 bot 是否具备创建私密话题权限（CreatePrivateThreads）",
        );
      }

      const buildConversationChannelId = thread.threadId;
      const buildConversationMention = `<#${thread.threadId}>`;

      await this.worldStore.setWorldBuildChannelId({
        worldId,
        channelId: buildConversationChannelId,
      });
      await this.worldStore.setChannelWorldId(
        buildConversationChannelId,
        worldId,
      );
      await this.worldStore.setChannelGroupId(
        buildConversationChannelId,
        buildWorldBuildGroupId(worldId),
      );

      await this.worldFiles.appendEvent(worldId, {
        type: "world_draft_build_thread_created",
        worldId,
        guildId: interaction.guildId,
        userId: interaction.user.id,
        threadId: buildConversationChannelId,
        parentChannelId: thread.parentChannelId,
      });

      await this.sendWorldCreateRules({
        guildId: interaction.guildId,
        channelId: buildConversationChannelId,
        worldId,
        traceId,
      });
      await this.emitSyntheticWorldBuildKickoff({
        channelId: buildConversationChannelId,
        userId: interaction.user.id,
        worldId,
        worldName,
        traceId,
      });

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
          `世界创建已开始：W${worldId}`,
          `继续创建（私密话题）：${buildConversationMention}`,
          `下一步：在私密话题里阅读规则后，直接发设定原文/上传文档；完成后执行 /world done 发布世界`,
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
        "- /world create（默认仅管理员；可配置 world.createPolicy）",
        "  - 执行后会创建一个私密话题：先阅读规则，再粘贴/上传设定原文，多轮补全；用 /world done 发布世界并创建子空间",
        "- /world open world_id:<世界ID>（仅创作者；打开该世界的私密编辑话题）",
        "- /world done（仅创作者；在世界私密编辑话题中发布草稿世界）",
        "- /world list [limit:<1-100>]",
        "- /world search query:<关键词> [limit:<1-50>]",
        "- /world info [world_id:<世界ID>]（在世界子空间频道内可省略 world_id）",
        "- /world rules [world_id:<世界ID>]（在世界子空间频道内可省略 world_id）",
        "- /world canon query:<关键词> [world_id:<世界ID>]（搜索该世界正典：世界卡/规则/canon；可在入口频道省略 world_id）",
        "- /world submit kind:<类型> title:<标题> content:<内容> [world_id:<世界ID>]（提案/任务/编年史/正典补充）",
        "- /world approve submission_id:<提交ID> [world_id:<世界ID>]（仅创作者；确认提案并写入 canon）",
        "- /world check query:<关键词> [world_id:<世界ID>]（冲突/检索：世界卡/规则/canon/提案）",
        "- /world join world_id:<世界ID> [character_id:<角色ID>]（加入世界获得发言权限；在世界子空间频道内可省略 world_id）",
        "- /world stats [world_id:<世界ID>]（或 /world status；在世界子空间频道内可省略 world_id）",
        "- /world remove world_id:<世界ID>（管理员）",
        "",
        "提示：",
        "- 所有人默认可查看世界子空间（只读）；加入后获得发言权限",
        "- 访客数=join 人数；角色数=该世界角色数（均持久化）",
      ].join("\n"),
      { ephemeral: true },
    );
  }

  private async handleWorldOpen(
    interaction: ChatInputCommandInteraction,
    worldId: number,
  ): Promise<void> {
    const meta = await this.worldStore.getWorld(worldId);
    if (!meta) {
      await safeReply(interaction, `世界不存在：W${worldId}`, {
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

    await this.ensureWorldBuildGroupAgent({
      worldId: meta.id,
      worldName: meta.name,
    });
    if (!interaction.guildId || !interaction.guild) {
      await safeReply(interaction, "该指令仅支持在服务器内使用。", {
        ephemeral: true,
      });
      return;
    }
    if (interaction.guildId !== meta.homeGuildId) {
      await safeReply(
        interaction,
        `请在世界入口服务器执行：guild:${meta.homeGuildId}`,
        { ephemeral: true },
      );
      return;
    }

    const workshop = await this.createCreatorOnlyChannel({
      guild: interaction.guild,
      name: `world-workshop-${interaction.user.id}`,
      creatorUserId: interaction.user.id,
      reason: `world workshop ensure for ${interaction.user.id}`,
    });

    const existingThreadId = meta.buildChannelId?.trim() || "";
    const fetched = existingThreadId
      ? await interaction.guild.channels
          .fetch(existingThreadId)
          .catch(() => null)
      : null;

    let buildConversationChannelId: string;
    if (fetched) {
      buildConversationChannelId = existingThreadId;
    } else {
      const thread = await this.tryCreatePrivateThread({
        guild: interaction.guild,
        parentChannelId: workshop.id,
        name: `世界编辑 W${meta.id}`,
        reason: `world open W${meta.id} by ${interaction.user.id}`,
        memberUserId: interaction.user.id,
      });
      if (!thread) {
        throw new Error(
          "无法创建世界私密话题：请检查 bot 是否具备创建私密话题权限（CreatePrivateThreads）",
        );
      }
      buildConversationChannelId = thread.threadId;
      await this.worldStore.setWorldBuildChannelId({
        worldId: meta.id,
        channelId: buildConversationChannelId,
      });
      await this.worldStore.setChannelWorldId(
        buildConversationChannelId,
        meta.id,
      );
      await this.worldFiles.appendEvent(meta.id, {
        type: "world_build_thread_created",
        worldId: meta.id,
        guildId: interaction.guildId,
        userId: interaction.user.id,
        threadId: buildConversationChannelId,
        parentChannelId: thread.parentChannelId,
      });

      await this.sendWorldCreateRules({
        guildId: interaction.guildId,
        channelId: buildConversationChannelId,
        worldId: meta.id,
      });
      await this.emitSyntheticWorldBuildKickoff({
        channelId: buildConversationChannelId,
        userId: interaction.user.id,
        worldId: meta.id,
        worldName: meta.name,
      });
    }

    await this.worldStore.setChannelGroupId(
      buildConversationChannelId,
      buildWorldBuildGroupId(meta.id),
    );

    await safeReply(
      interaction,
      `已打开世界编辑：W${meta.id} ${meta.name}\n私密话题：<#${buildConversationChannelId}>`,
      { ephemeral: true },
    );
  }

  private async handleWorldPublish(
    interaction: ChatInputCommandInteraction,
  ): Promise<void> {
    const groupId = await this.worldStore.getGroupIdByChannel(
      interaction.channelId,
    );
    const parsed = groupId ? parseWorldGroup(groupId) : null;
    if (!parsed || parsed.kind !== "build") {
      await safeReply(
        interaction,
        "请先在私密话题中执行 /world create 或 /world open，然后再执行 /world done。",
        { ephemeral: true },
      );
      return;
    }

    const meta = await this.worldStore.getWorld(parsed.worldId);
    if (!meta) {
      await safeReply(interaction, `世界不存在：W${parsed.worldId}`, {
        ephemeral: true,
      });
      return;
    }
    if (meta.creatorId !== interaction.user.id) {
      await safeReply(interaction, "无权限：只有世界创作者可以发布世界。", {
        ephemeral: true,
      });
      return;
    }

    await safeDefer(interaction, { ephemeral: true });

    if (meta.status !== "draft") {
      await safeReply(
        interaction,
        `世界已发布：W${meta.id} ${meta.name}（status=${meta.status}）`,
        { ephemeral: true },
      );
      return;
    }

    const guild = await this.client.guilds
      .fetch(meta.homeGuildId)
      .catch(() => null);
    if (!guild) {
      await safeReply(
        interaction,
        `无法获取世界入口服务器：guild:${meta.homeGuildId}`,
        { ephemeral: true },
      );
      return;
    }

    const card = await this.worldFiles.readWorldCard(meta.id);
    const extractedWorldName = extractWorldNameFromCard(card);
    const worldName = extractedWorldName?.trim() || meta.name;
    if (extractedWorldName && extractedWorldName.trim() !== meta.name) {
      await this.worldStore
        .setWorldName({ worldId: meta.id, name: extractedWorldName.trim() })
        .catch(() => {});
    }

    const created = await this.createWorldSubspace({
      guild,
      worldId: meta.id,
      worldName,
      creatorUserId: meta.creatorId,
    });

    await this.worldStore.publishWorld({
      id: meta.id,
      homeGuildId: meta.homeGuildId,
      creatorId: meta.creatorId,
      name: worldName,
      createdAt: meta.createdAt,
      updatedAt: new Date().toISOString(),
      roleId: created.roleId,
      categoryId: created.categoryId,
      infoChannelId: created.infoChannelId,
      roleplayChannelId: created.discussionChannelId,
      proposalsChannelId: created.proposalsChannelId,
      voiceChannelId: created.voiceChannelId,
    });

    await this.ensureWorldGroupAgent({
      worldId: meta.id,
      worldName,
    });

    try {
      const member = await guild.members.fetch(meta.creatorId);
      await member.roles.add(created.roleId, "world creator auto-join");
    } catch {
      // ignore
    }
    await this.worldStore.addMember(meta.id, meta.creatorId).catch(() => false);
    await this.worldFiles.ensureMember(meta.id, meta.creatorId).catch(() => {});

    await this.pushWorldInfoSnapshot({
      guildId: meta.homeGuildId,
      worldId: meta.id,
      worldName,
      infoChannelId: created.infoChannelId,
    });

    await safeReply(
      interaction,
      [
        `世界已发布：W${meta.id} ${worldName}`,
        `公告：<#${created.infoChannelId}>`,
        `讨论：<#${created.discussionChannelId}>`,
        `提案：<#${created.proposalsChannelId}>`,
        `加入：/world join world_id:${meta.id}`,
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
    const active = metas.filter((meta): meta is NonNullable<typeof meta> =>
      Boolean(meta && meta.status === "active"),
    );
    const cards = await Promise.all(
      active.map((meta) => this.worldFiles.readWorldCard(meta.id)),
    );
    const lines = active.map((meta, idx) => {
      const summary = extractWorldOneLiner(cards[idx] ?? null);
      return summary
        ? `W${meta.id} ${meta.name} — ${summary}（入口 guild:${meta.homeGuildId}）`
        : `W${meta.id} ${meta.name}（入口 guild:${meta.homeGuildId}）`;
    });
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
    const stats = await this.worldFiles.readStats(meta.id);
    const creatorLabel = await this.resolveDiscordUserLabel({
      userId: meta.creatorId,
      guild:
        interaction.guildId === meta.homeGuildId ? interaction.guild : null,
    });
    const channels =
      meta.status === "draft"
        ? []
        : [
            `公告：<#${meta.infoChannelId}>`,
            `讨论：<#${meta.roleplayChannelId}>`,
            `提案：<#${meta.proposalsChannelId}>`,
            `加入：/world join world_id:${meta.id}`,
          ];
    const header = [
      `W${meta.id} ${meta.name}`,
      `创作者：${creatorLabel}`,
      `入口 guild:${meta.homeGuildId}`,
      `状态：${meta.status === "draft" ? "draft(未发布)" : meta.status}`,
      `访客数：${stats.visitorCount}`,
      `角色数：${stats.characterCount}`,
      ...channels,
      ``,
    ].join("\n");
    const body = card?.trim()
      ? patchCreatorLineInMarkdown(card.trim(), meta.creatorId, creatorLabel)
      : "(世界卡缺失)";
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
    const [card, rules, chronicle, tasks, news, canon] = await Promise.all([
      this.worldFiles.readWorldCard(meta.id),
      this.worldFiles.readRules(meta.id),
      this.worldFiles.readCanon(meta.id, "chronicle.md"),
      this.worldFiles.readCanon(meta.id, "tasks.md"),
      this.worldFiles.readCanon(meta.id, "news.md"),
      this.worldFiles.readCanon(meta.id, "canon.md"),
    ]);
    const hits: string[] = [];
    if (meta.name.toLowerCase().includes(lowered)) hits.push("name");
    if (card?.toLowerCase().includes(lowered)) hits.push("world-card");
    if (rules?.toLowerCase().includes(lowered)) hits.push("rules");
    if (chronicle?.toLowerCase().includes(lowered)) hits.push("chronicle");
    if (tasks?.toLowerCase().includes(lowered)) hits.push("tasks");
    if (news?.toLowerCase().includes(lowered)) hits.push("news");
    if (canon?.toLowerCase().includes(lowered)) hits.push("canon");

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

  private async handleWorldSubmit(
    interaction: ChatInputCommandInteraction,
    input: {
      worldId: number;
      kind: "canon" | "chronicle" | "task" | "news";
      title: string;
      content: string;
    },
  ): Promise<void> {
    const meta = await this.worldStore.getWorld(input.worldId);
    if (!meta) {
      await safeReply(interaction, `世界不存在：W${input.worldId}`, {
        ephemeral: true,
      });
      return;
    }
    if (meta.status === "draft" && meta.creatorId !== interaction.user.id) {
      await safeReply(
        interaction,
        `世界尚未发布：W${meta.id}（仅创作者可见）`,
        {
          ephemeral: true,
        },
      );
      return;
    }

    await safeDefer(interaction, { ephemeral: true });

    const submissionId = await this.worldStore.nextWorldSubmissionId(meta.id);
    const nowIso = new Date().toISOString();
    const payload = buildWorldSubmissionMarkdown({
      worldId: meta.id,
      worldName: meta.name,
      submissionId,
      kind: input.kind,
      title: input.title,
      content: input.content,
      submitterUserId: interaction.user.id,
      createdAt: nowIso,
    });

    await this.worldFiles.writeSubmission(
      meta.id,
      "pending",
      submissionId,
      payload,
    );
    await this.worldFiles.appendEvent(meta.id, {
      type: "world_submission_created",
      worldId: meta.id,
      submissionId,
      kind: input.kind,
      title: input.title,
      userId: interaction.user.id,
    });

    if (meta.status === "active") {
      await this.sendLongTextToChannel({
        guildId: meta.homeGuildId,
        channelId: meta.proposalsChannelId,
        content: [
          `【世界提案】W${meta.id} ${meta.name} / S${submissionId}`,
          `类型：${input.kind} 标题：${input.title}`,
          `提交者：<@${interaction.user.id}>`,
          `审核：/world approve submission_id:${submissionId} world_id:${meta.id}`,
        ].join("\n"),
      });
    }

    await safeReply(
      interaction,
      meta.status === "active"
        ? `已提交：S${submissionId}（已发到 <#${meta.proposalsChannelId}>，等待创作者确认）`
        : `已提交：S${submissionId}（当前世界未发布，仅保存为草稿提案）`,
      { ephemeral: true },
    );
  }

  private async handleWorldApprove(
    interaction: ChatInputCommandInteraction,
    input: { worldId: number; submissionId: number },
  ): Promise<void> {
    const meta = await this.worldStore.getWorld(input.worldId);
    if (!meta) {
      await safeReply(interaction, `世界不存在：W${input.worldId}`, {
        ephemeral: true,
      });
      return;
    }
    if (meta.creatorId !== interaction.user.id) {
      await safeReply(interaction, "无权限：只有世界创作者可以确认提案。", {
        ephemeral: true,
      });
      return;
    }
    if (meta.status !== "active") {
      await safeReply(interaction, "世界尚未发布，无法确认提案。", {
        ephemeral: true,
      });
      return;
    }

    await safeDefer(interaction, { ephemeral: true });

    const pending = await this.worldFiles.readSubmission(
      meta.id,
      "pending",
      input.submissionId,
    );
    if (!pending) {
      await safeReply(interaction, `未找到待确认提案：S${input.submissionId}`, {
        ephemeral: true,
      });
      return;
    }

    const parsed = parseWorldSubmissionMarkdown(pending);
    const kind = parsed?.kind ?? "canon";
    const title = parsed?.title ?? `(S${input.submissionId})`;
    const submitter = parsed?.submitterUserId ?? "";
    const content = parsed?.content ?? pending.trim();

    const moved = await this.worldFiles.moveSubmission({
      worldId: meta.id,
      from: "pending",
      to: "approved",
      submissionId: input.submissionId,
    });
    if (!moved) {
      await safeReply(
        interaction,
        `提案状态变化：S${input.submissionId} 不存在`,
        {
          ephemeral: true,
        },
      );
      return;
    }

    const filename =
      kind === "chronicle"
        ? "chronicle.md"
        : kind === "task"
          ? "tasks.md"
          : kind === "news"
            ? "news.md"
            : "canon.md";

    const nowIso = new Date().toISOString();
    await this.worldFiles.appendCanon(
      meta.id,
      filename,
      [
        ``,
        `## S${input.submissionId} ${title}`,
        `- 时间：${nowIso}`,
        submitter ? `- 提交者：<@${submitter}>` : null,
        `- 来源：submissions/approved/${input.submissionId}.md`,
        ``,
        content,
        ``,
      ]
        .filter((line): line is string => Boolean(line))
        .join("\n"),
    );

    await this.worldFiles.appendEvent(meta.id, {
      type: "world_submission_approved",
      worldId: meta.id,
      submissionId: input.submissionId,
      kind,
      title,
      approverUserId: interaction.user.id,
    });

    await this.sendLongTextToChannel({
      guildId: meta.homeGuildId,
      channelId: meta.proposalsChannelId,
      content: [
        `【提案已确认】W${meta.id} ${meta.name} / S${input.submissionId}`,
        `类型：${kind} 标题：${title}`,
        `已写入：canon/${filename}`,
      ].join("\n"),
    });

    await safeReply(
      interaction,
      `已确认：S${input.submissionId}（写入 canon/${filename}）`,
      { ephemeral: true },
    );
  }

  private async handleWorldCheck(
    interaction: ChatInputCommandInteraction,
    input: { worldId: number; query: string },
  ): Promise<void> {
    const query = input.query.trim();
    if (!query) {
      await safeReply(interaction, "query 不能为空。", { ephemeral: true });
      return;
    }

    const meta = await this.worldStore.getWorld(input.worldId);
    if (!meta) {
      await safeReply(interaction, `世界不存在：W${input.worldId}`, {
        ephemeral: true,
      });
      return;
    }
    if (meta.status === "draft" && meta.creatorId !== interaction.user.id) {
      await safeReply(
        interaction,
        `世界尚未发布：W${meta.id}（仅创作者可见）`,
        {
          ephemeral: true,
        },
      );
      return;
    }

    const lowered = query.toLowerCase();
    const hits: string[] = [];

    const [card, rules] = await Promise.all([
      this.worldFiles.readWorldCard(meta.id),
      this.worldFiles.readRules(meta.id),
    ]);
    if (card?.toLowerCase().includes(lowered)) hits.push("world-card.md");
    if (rules?.toLowerCase().includes(lowered)) hits.push("rules.md");

    const canonFiles = [
      "chronicle.md",
      "tasks.md",
      "news.md",
      "canon.md",
    ] as const;
    for (const filename of canonFiles) {
      const content = await this.worldFiles.readCanon(meta.id, filename);
      if (content?.toLowerCase().includes(lowered)) {
        hits.push(`canon/${filename}`);
      }
    }

    const pendingIds = await this.worldFiles.listSubmissionIds(
      meta.id,
      "pending",
      50,
    );
    for (const id of pendingIds) {
      const content = await this.worldFiles.readSubmission(
        meta.id,
        "pending",
        id,
      );
      if (content?.toLowerCase().includes(lowered)) {
        hits.push(`submissions/pending/${id}.md`);
      }
    }
    const approvedIds = await this.worldFiles.listSubmissionIds(
      meta.id,
      "approved",
      50,
    );
    for (const id of approvedIds) {
      const content = await this.worldFiles.readSubmission(
        meta.id,
        "approved",
        id,
      );
      if (content?.toLowerCase().includes(lowered)) {
        hits.push(`submissions/approved/${id}.md`);
      }
    }

    if (hits.length === 0) {
      await safeReply(
        interaction,
        `W${meta.id} ${meta.name}\n未找到包含「${query}」的内容。`,
        { ephemeral: true },
      );
      return;
    }

    const lines = hits.slice(0, 30).map((hit) => `- ${hit}`);
    await safeReply(
      interaction,
      [`W${meta.id} ${meta.name}`, `命中 ${hits.length} 处：`, ...lines].join(
        "\n",
      ),
      { ephemeral: true },
    );
  }

  private async handleWorldJoin(
    interaction: ChatInputCommandInteraction,
    input: { worldId: number; characterId?: number },
  ): Promise<void> {
    const meta = await this.worldStore.getWorld(input.worldId);
    if (!meta) {
      await safeReply(interaction, `世界不存在：W${input.worldId}`, {
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

    try {
      const member = await interaction.guild.members.fetch(interaction.user.id);
      await member.roles.add(meta.roleId, "world join");
      await this.worldStore
        .addMember(meta.id, interaction.user.id)
        .catch(() => false);
      const persisted = await this.worldFiles
        .ensureMember(meta.id, interaction.user.id)
        .catch(async () => ({
          added: false,
          stats: await this.worldFiles.readStats(meta.id),
        }));
      if (persisted.added) {
        await this.worldFiles.appendEvent(meta.id, {
          type: "world_joined",
          worldId: meta.id,
          userId: interaction.user.id,
        });
      }
      const selectedCharacterId = await this.resolveJoinCharacterId({
        userId: interaction.user.id,
        explicitCharacterId: input.characterId,
      });

      const worldCharacter = await this.ensureWorldSpecificCharacter({
        worldId: meta.id,
        worldName: meta.name,
        userId: interaction.user.id,
        sourceCharacterId: selectedCharacterId,
      });

      await this.worldStore.setActiveCharacter({
        worldId: meta.id,
        userId: interaction.user.id,
        characterId: worldCharacter.characterId,
      });
      await this.worldStore
        .addCharacterToWorld(meta.id, worldCharacter.characterId)
        .catch(() => false);
      await this.worldFiles
        .ensureWorldCharacter(meta.id, worldCharacter.characterId)
        .catch(() => {});

      await this.userState
        .addJoinedWorld(interaction.user.id, meta.id)
        .catch(() => {});

      if (worldCharacter.forked) {
        await this.maybeStartWorldCharacterAutoFix({
          worldId: meta.id,
          worldName: meta.name,
          userId: interaction.user.id,
          characterId: worldCharacter.characterId,
        }).catch((err) => {
          this.logger.warn({ err }, "Failed to start world character auto-fix");
        });
      }

      await safeReply(
        interaction,
        [
          `已加入世界：W${meta.id} ${meta.name}`,
          `讨论：<#${meta.roleplayChannelId}>`,
          `当前角色：C${worldCharacter.characterId}${
            worldCharacter.forked
              ? `（本世界专用，fork自 C${worldCharacter.sourceCharacterId}）`
              : ""
          }`,
        ].join("\n"),
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
    const stats = await this.worldFiles.readStats(meta.id);
    await safeReply(
      interaction,
      `W${meta.id} ${meta.name}\n状态：${
        meta.status === "draft" ? "draft(未发布)" : meta.status
      }\n访客数：${stats.visitorCount}\n角色数：${stats.characterCount}`,
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
        const card = await this.worldFiles.readWorldCard(meta.id);
        const summary = extractWorldOneLiner(card);
        results.push(
          summary
            ? `W${meta.id} ${meta.name} — ${summary}（命中：name）`
            : `W${meta.id} ${meta.name}（命中：name）`,
        );
        continue;
      }
      const [card, rules] = await Promise.all([
        this.worldFiles.readWorldCard(meta.id),
        this.worldFiles.readRules(meta.id),
      ]);
      if (card?.toLowerCase().includes(lowered)) {
        const summary = extractWorldOneLiner(card);
        results.push(
          summary
            ? `W${meta.id} ${meta.name} — ${summary}（命中：world-card）`
            : `W${meta.id} ${meta.name}（命中：world-card）`,
        );
        continue;
      }
      if (rules?.toLowerCase().includes(lowered)) {
        const summary = extractWorldOneLiner(card);
        results.push(
          summary
            ? `W${meta.id} ${meta.name} — ${summary}（命中：rules）`
            : `W${meta.id} ${meta.name}（命中：rules）`,
        );
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
    await safeReply(
      interaction,
      `该指令已弃用：请使用 /world open world_id:${input.worldId}（在私密话题中）后，在私密话题里继续编辑并 /world done 发布。`,
      { ephemeral: true },
    );
  }

  private async handleWorldDone(
    interaction: ChatInputCommandInteraction,
  ): Promise<void> {
    await safeReply(interaction, "请在私密话题中执行 /world done 发布世界。", {
      ephemeral: true,
    });
  }

  private async handleWorldRemove(
    interaction: ChatInputCommandInteraction,
    worldId: number,
    flags: { isGuildOwner: boolean; isGuildAdmin: boolean },
  ): Promise<void> {
    if (!interaction.guildId || !interaction.guild) {
      await safeReply(interaction, "该指令仅支持在服务器内使用。", {
        ephemeral: true,
      });
      return;
    }
    await safeDefer(interaction, { ephemeral: true });

    const groupPath = await this.groupRepository.ensureGroupDir(
      interaction.guildId,
    );
    const groupConfig = await this.groupRepository.loadConfig(groupPath);
    const isConfiguredAdmin = groupConfig.adminUsers.includes(
      interaction.user.id,
    );
    const isGuildAdmin = flags.isGuildOwner || flags.isGuildAdmin;
    if (!isConfiguredAdmin && !isGuildAdmin) {
      await safeReply(interaction, "无权限：仅管理员可移除世界。", {
        ephemeral: true,
      });
      return;
    }

    const meta = await this.worldStore.getWorld(worldId);
    if (!meta) {
      await safeReply(interaction, `世界不存在：W${worldId}`, {
        ephemeral: true,
      });
      return;
    }

    if (meta.status !== "draft" && interaction.guildId !== meta.homeGuildId) {
      await safeReply(
        interaction,
        `请在世界入口服务器执行该指令：guild:${meta.homeGuildId}`,
        { ephemeral: true },
      );
      return;
    }

    const guild = interaction.guild;
    const deleted: string[] = [];

    if (meta.status !== "draft") {
      const categoryId = meta.categoryId?.trim() ?? "";
      const category =
        categoryId && guild.channels.cache.has(categoryId)
          ? guild.channels.cache.get(categoryId)
          : await guild.channels.fetch(categoryId).catch(() => null);

      if (category && category.type === ChannelType.GuildCategory) {
        const children = guild.channels.cache.filter(
          (candidate) => candidate.parentId === category.id,
        );
        for (const channel of children.values()) {
          try {
            await channel.delete(`world remove W${meta.id}`);
            deleted.push(`channel:${channel.id}`);
          } catch {
            // ignore
          }
        }
        try {
          await category.delete(`world remove W${meta.id}`);
          deleted.push(`category:${category.id}`);
        } catch {
          // ignore
        }
      } else {
        const candidates = [
          meta.infoChannelId,
          meta.joinChannelId,
          meta.roleplayChannelId,
          meta.proposalsChannelId,
          meta.voiceChannelId,
          meta.buildChannelId,
        ].filter((value): value is string => Boolean(value && value.trim()));
        for (const channelId of candidates) {
          try {
            const channel = await guild.channels
              .fetch(channelId)
              .catch(() => null);
            if (channel) {
              await channel.delete(`world remove W${meta.id}`);
              deleted.push(`channel:${channel.id}`);
            }
          } catch {
            // ignore
          }
        }
      }

      try {
        const role = await guild.roles.fetch(meta.roleId).catch(() => null);
        if (role) {
          await role.delete(`world remove W${meta.id}`);
          deleted.push(`role:${role.id}`);
        }
      } catch {
        // ignore
      }
    }

    const purge = await this.worldStore.purgeWorld(meta);
    await rm(this.worldFiles.worldDir(meta.id), {
      recursive: true,
      force: true,
    });

    await safeReply(
      interaction,
      [
        `已移除世界：W${meta.id} ${meta.name}（status=${meta.status}）`,
        `清理：成员 ${purge.deletedMembers}、角色 ${purge.deletedWorldCharacters}`,
        deleted.length > 0
          ? `已删除 Discord 资源：${deleted.length}`
          : "Discord 资源删除：跳过/失败（请手工检查）",
      ].join("\n"),
      { ephemeral: true },
    );
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
    if (subcommand === "open") {
      const characterId = interaction.options.getInteger("character_id", true);
      await this.handleCharacterOpen(interaction, characterId);
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
    if (subcommand === "use") {
      const characterId = interaction.options.getInteger("character_id", true);
      await this.handleCharacterUse(interaction, characterId);
      return;
    }
    if (subcommand === "publish") {
      const characterId =
        interaction.options.getInteger("character_id") ?? undefined;
      await this.handleCharacterPublish(interaction, characterId);
      return;
    }
    if (subcommand === "unpublish") {
      const characterId =
        interaction.options.getInteger("character_id") ?? undefined;
      await this.handleCharacterUnpublish(interaction, characterId);
      return;
    }
    if (subcommand === "list") {
      const limit = interaction.options.getInteger("limit") ?? undefined;
      await this.handleCharacterList(interaction, { limit });
      return;
    }
    if (subcommand === "search") {
      const query = interaction.options.getString("query", true);
      const limit = interaction.options.getInteger("limit") ?? undefined;
      await this.handleCharacterSearch(interaction, { query, limit });
      return;
    }
    if (subcommand === "adopt") {
      const characterId = interaction.options.getInteger("character_id", true);
      const modeRaw = interaction.options.getString("mode", true);
      const mode = modeRaw === "fork" ? "fork" : "copy";
      await this.handleCharacterAdopt(interaction, { characterId, mode });
      return;
    }
    await safeReply(interaction, `未知子命令：/character ${subcommand}`, {
      ephemeral: false,
    });
  }

  private async handleCharacterCreate(
    interaction: ChatInputCommandInteraction,
  ): Promise<void> {
    if (!interaction.guildId || !interaction.guild) {
      await safeReply(interaction, "该指令仅支持在服务器内使用。", {
        ephemeral: true,
      });
      return;
    }
    const homeGuildId = getConfig().DISCORD_HOME_GUILD_ID?.trim();
    if (homeGuildId && interaction.guildId !== homeGuildId) {
      await safeReply(
        interaction,
        `当前仅允许在 homeGuild 创建角色：guild:${homeGuildId}`,
        { ephemeral: true },
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
    });
    const visibilityRaw =
      (interaction.options.getString(
        "visibility",
      ) as CharacterVisibility | null) ?? "private";
    const visibility: CharacterVisibility =
      visibilityRaw === "public" ? "public" : "private";
    const description =
      interaction.options.getString("description")?.trim() ?? "";
    const nameRaw = interaction.options.getString("name")?.trim() ?? "";

    const characterId = await this.worldStore.nextCharacterId();
    const nowIso = new Date().toISOString();
    const name = nameRaw || `Character-${characterId}`;
    await this.worldStore.createCharacter({
      id: characterId,
      creatorId: interaction.user.id,
      name,
      visibility,
      status: "active",
      createdAt: nowIso,
      updatedAt: nowIso,
    });
    await this.worldFiles.writeCharacterCard(
      characterId,
      buildDefaultCharacterCard({
        characterId,
        name,
        creatorId: interaction.user.id,
        description,
      }),
    );
    await this.worldFiles.appendCharacterEvent(characterId, {
      type: "character_created",
      characterId,
      userId: interaction.user.id,
    });
    await this.userState.markCharacterCreated(interaction.user.id);

    await this.ensureCharacterBuildGroupAgent({
      characterId,
      characterName: name,
    });

    let buildConversationChannelId = interaction.channelId;
    let buildConversationMention = "(创建失败)";

    const workshop = await this.createCreatorOnlyChannel({
      guild: interaction.guild,
      name: `character-workshop-${interaction.user.id}`,
      creatorUserId: interaction.user.id,
      reason: `character workshop ensure for ${interaction.user.id}`,
    });
    const thread = await this.tryCreatePrivateThread({
      guild: interaction.guild,
      parentChannelId: workshop.id,
      name: `角色创建 C${characterId}`,
      reason: `character create C${characterId} by ${interaction.user.id}`,
      memberUserId: interaction.user.id,
    });
    if (!thread) {
      throw new Error(
        "无法创建角色私密话题：请检查 bot 是否具备创建私密话题权限（CreatePrivateThreads）",
      );
    }
    buildConversationChannelId = thread.threadId;
    buildConversationMention = `<#${thread.threadId}>`;

    await this.worldStore.setCharacterBuildChannelId({
      characterId,
      channelId: buildConversationChannelId,
    });
    await this.worldStore.setChannelGroupId(
      buildConversationChannelId,
      buildCharacterBuildGroupId(characterId),
    );

    await this.sendCharacterCreateRules({
      guildId: interaction.guildId,
      channelId: buildConversationChannelId,
      characterId,
      traceId,
    });
    await this.emitSyntheticCharacterBuildKickoff({
      channelId: buildConversationChannelId,
      userId: interaction.user.id,
      characterId,
      characterName: name,
      traceId,
    });

    feishuLogJson({
      event: "discord.character.create.success",
      traceId,
      interactionId: interaction.id,
      characterId,
      characterName: name,
      visibility,
      buildConversationChannelId,
    });
    await safeReply(
      interaction,
      [
        `角色已创建：C${characterId} ${name}（visibility=${visibility}）`,
        `完善角色卡（私密话题）：${buildConversationMention}`,
        `设为默认角色：/character use character_id:${characterId}`,
      ].join("\n"),
      { ephemeral: true },
    );
  }

  private async handleCharacterHelp(
    interaction: ChatInputCommandInteraction,
  ): Promise<void> {
    await safeReply(
      interaction,
      [
        "角色系统指令：",
        "- /character create [name:<角色名>] [visibility:public|private] [description:<补充>]",
        "  - 会创建一个私密话题，多轮补全角色卡；默认 visibility=private",
        "- /character open character_id:<角色ID>（仅创作者；打开该角色的私密编辑话题）",
        "- /character view character_id:<角色ID>（遵循 visibility 权限）",
        "- /character use character_id:<角色ID>（设置你的默认角色，全局）",
        "- /character act character_id:<角色ID>（在世界频道内执行：设置你在该世界的当前角色）",
        "- /character publish [character_id:<角色ID>]（设为 public）",
        "- /character unpublish [character_id:<角色ID>]（设为 private）",
        "- /character list [limit:<1-100>]（列出我的角色）",
        "- /character search query:<关键词> [limit:<1-50>]（搜索 public 角色）",
        "- /character adopt character_id:<角色ID> mode:copy|fork（把 public 角色变成你的角色）",
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
      (meta.visibility === "private" && meta.creatorId === interaction.user.id);
    if (!allowed) {
      await safeReply(interaction, "无权限查看该角色卡。", {
        ephemeral: false,
      });
      return;
    }
    const card = await this.worldFiles.readCharacterCard(meta.id);
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
    if (meta.creatorId !== interaction.user.id) {
      await safeReply(interaction, "无权限：只能使用你自己创建的角色。", {
        ephemeral: false,
      });
      return;
    }

    const inferredWorldId = interaction.channelId
      ? await this.worldStore.getWorldIdByChannel(interaction.channelId)
      : null;
    const worldId =
      inferredWorldId ??
      (await this.inferWorldIdFromWorldSubspace(interaction).catch(() => null));
    if (!worldId) {
      await safeReply(
        interaction,
        "请在目标世界频道内执行 /character act（或先 /world join 进入世界）。",
        { ephemeral: false },
      );
      return;
    }

    const isMember =
      (await this.worldStore
        .isMember(worldId, interaction.user.id)
        .catch(() => false)) ||
      (await this.worldFiles
        .hasMember(worldId, interaction.user.id)
        .catch(() => false));
    if (!isMember) {
      await safeReply(interaction, "你尚未加入该世界，无法设置当前角色。", {
        ephemeral: false,
      });
      return;
    }

    const worldMeta = await this.worldStore.getWorld(worldId);
    if (!worldMeta || worldMeta.status !== "active") {
      await safeReply(interaction, "当前世界不可用（尚未发布或已被移除）。", {
        ephemeral: false,
      });
      return;
    }

    const worldCharacter = await this.ensureWorldSpecificCharacter({
      worldId: worldMeta.id,
      worldName: worldMeta.name,
      userId: interaction.user.id,
      sourceCharacterId: meta.id,
    });
    await this.worldStore.setActiveCharacter({
      worldId: worldMeta.id,
      userId: interaction.user.id,
      characterId: worldCharacter.characterId,
    });
    await this.worldStore
      .addCharacterToWorld(worldMeta.id, worldCharacter.characterId)
      .catch(() => false);
    await this.worldFiles
      .ensureWorldCharacter(worldMeta.id, worldCharacter.characterId)
      .catch(() => {});
    if (worldCharacter.forked) {
      await this.maybeStartWorldCharacterAutoFix({
        worldId: worldMeta.id,
        worldName: worldMeta.name,
        userId: interaction.user.id,
        characterId: worldCharacter.characterId,
      }).catch((err) => {
        this.logger.warn({ err }, "Failed to start world character auto-fix");
      });
    }
    await safeReply(
      interaction,
      [
        `已设置你的当前角色：C${worldCharacter.characterId} ${
          worldCharacter.forked
            ? `（本世界专用，fork自 C${meta.id}）`
            : meta.name
        }`,
        `接下来你在世界入口频道的发言将视为该角色的行动/台词；bot 会作为旁白/世界系统回应。`,
      ].join("\n"),
      { ephemeral: false },
    );
  }

  private async handleCharacterOpen(
    interaction: ChatInputCommandInteraction,
    characterId: number,
  ): Promise<void> {
    const meta = await this.worldStore.getCharacter(characterId);
    if (!meta) {
      await safeReply(interaction, `角色不存在：C${characterId}`, {
        ephemeral: true,
      });
      return;
    }
    if (meta.creatorId !== interaction.user.id) {
      await safeReply(interaction, "无权限：只有角色创作者可以编辑角色卡。", {
        ephemeral: true,
      });
      return;
    }

    await this.ensureCharacterBuildGroupAgent({
      characterId: meta.id,
      characterName: meta.name,
    });

    if (!interaction.guildId || !interaction.guild) {
      await safeReply(interaction, "该指令仅支持在服务器内使用。", {
        ephemeral: true,
      });
      return;
    }
    const homeGuildId = getConfig().DISCORD_HOME_GUILD_ID?.trim();
    if (homeGuildId && interaction.guildId !== homeGuildId) {
      await safeReply(
        interaction,
        `请在 homeGuild 执行：guild:${homeGuildId}`,
        { ephemeral: true },
      );
      return;
    }

    const workshop = await this.createCreatorOnlyChannel({
      guild: interaction.guild,
      name: `character-workshop-${interaction.user.id}`,
      creatorUserId: interaction.user.id,
      reason: `character workshop ensure for ${interaction.user.id}`,
    });

    const existingThreadId = meta.buildChannelId?.trim() || "";
    const fetched = existingThreadId
      ? await interaction.guild.channels
          .fetch(existingThreadId)
          .catch(() => null)
      : null;

    let conversationChannelId: string;
    if (fetched) {
      conversationChannelId = existingThreadId;
    } else {
      const thread = await this.tryCreatePrivateThread({
        guild: interaction.guild,
        parentChannelId: workshop.id,
        name: `角色编辑 C${meta.id}`,
        reason: `character open C${meta.id} by ${interaction.user.id}`,
        memberUserId: interaction.user.id,
      });
      if (!thread) {
        throw new Error(
          "无法创建角色私密话题：请检查 bot 是否具备创建私密话题权限（CreatePrivateThreads）",
        );
      }
      conversationChannelId = thread.threadId;
      await this.worldStore.setCharacterBuildChannelId({
        characterId: meta.id,
        channelId: conversationChannelId,
      });
      await this.sendCharacterCreateRules({
        guildId: interaction.guildId,
        channelId: conversationChannelId,
        characterId: meta.id,
      });
      await this.emitSyntheticCharacterBuildKickoff({
        channelId: conversationChannelId,
        userId: interaction.user.id,
        characterId: meta.id,
        characterName: meta.name,
      });
    }

    await this.worldStore.setChannelGroupId(
      conversationChannelId,
      buildCharacterBuildGroupId(meta.id),
    );

    await safeReply(
      interaction,
      `已打开角色卡编辑：C${meta.id} ${meta.name}\n私密话题：<#${conversationChannelId}>`,
      { ephemeral: true },
    );
  }

  private async handleCharacterUse(
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
    if (meta.creatorId !== interaction.user.id) {
      await safeReply(interaction, "无权限：只能使用你自己创建的角色。", {
        ephemeral: false,
      });
      return;
    }
    await this.worldStore.setGlobalActiveCharacter({
      userId: interaction.user.id,
      characterId: meta.id,
    });
    await safeReply(
      interaction,
      `已设置你的默认角色：C${meta.id} ${meta.name}`,
      { ephemeral: false },
    );
  }

  private async handleCharacterPublish(
    interaction: ChatInputCommandInteraction,
    characterId?: number,
  ): Promise<void> {
    let resolved: number;
    try {
      resolved = await this.resolveCharacterIdForVisibilityCommand(
        interaction,
        characterId,
      );
    } catch (err) {
      await safeReply(
        interaction,
        err instanceof Error ? err.message : String(err),
        { ephemeral: true },
      );
      return;
    }
    const meta = await this.worldStore.getCharacter(resolved);
    if (!meta) {
      await safeReply(interaction, `角色不存在：C${resolved}`, {
        ephemeral: true,
      });
      return;
    }
    if (meta.creatorId !== interaction.user.id) {
      await safeReply(interaction, "无权限：只有角色创作者可以修改可见性。", {
        ephemeral: true,
      });
      return;
    }
    await this.worldStore.setCharacterVisibility({
      characterId: meta.id,
      visibility: "public",
    });
    await safeReply(interaction, `已公开角色：C${meta.id} ${meta.name}`, {
      ephemeral: true,
    });
  }

  private async handleCharacterUnpublish(
    interaction: ChatInputCommandInteraction,
    characterId?: number,
  ): Promise<void> {
    let resolved: number;
    try {
      resolved = await this.resolveCharacterIdForVisibilityCommand(
        interaction,
        characterId,
      );
    } catch (err) {
      await safeReply(
        interaction,
        err instanceof Error ? err.message : String(err),
        { ephemeral: true },
      );
      return;
    }
    const meta = await this.worldStore.getCharacter(resolved);
    if (!meta) {
      await safeReply(interaction, `角色不存在：C${resolved}`, {
        ephemeral: true,
      });
      return;
    }
    if (meta.creatorId !== interaction.user.id) {
      await safeReply(interaction, "无权限：只有角色创作者可以修改可见性。", {
        ephemeral: true,
      });
      return;
    }
    await this.worldStore.setCharacterVisibility({
      characterId: meta.id,
      visibility: "private",
    });
    await safeReply(interaction, `已设为私密：C${meta.id} ${meta.name}`, {
      ephemeral: true,
    });
  }

  private async handleCharacterList(
    interaction: ChatInputCommandInteraction,
    input: { limit?: number },
  ): Promise<void> {
    const limit = Math.max(1, Math.min(100, Math.floor(input.limit ?? 20)));
    const ids = await this.worldStore.listUserCharacterIds(
      interaction.user.id,
      limit,
    );
    if (ids.length === 0) {
      await safeReply(interaction, "你还没有角色卡：请先 /character create。", {
        ephemeral: true,
      });
      return;
    }
    const metas = await Promise.all(
      ids.map((id) => this.worldStore.getCharacter(id)),
    );
    const lines = metas
      .filter((meta): meta is NonNullable<typeof meta> => Boolean(meta))
      .map(
        (meta) => `C${meta.id} ${meta.name}（visibility=${meta.visibility}）`,
      );
    await safeReply(interaction, lines.join("\n"), { ephemeral: true });
  }

  private async handleCharacterSearch(
    interaction: ChatInputCommandInteraction,
    input: { query: string; limit?: number },
  ): Promise<void> {
    const query = input.query.trim();
    if (!query) {
      await safeReply(interaction, "query 不能为空。", { ephemeral: true });
      return;
    }
    const limit = Math.max(1, Math.min(50, Math.floor(input.limit ?? 10)));
    const ids = await this.worldStore.listPublicCharacterIds(200);
    const lowered = query.toLowerCase();
    const numeric = Number(query);
    const results: string[] = [];
    for (const id of ids) {
      if (results.length >= limit) {
        break;
      }
      const meta = await this.worldStore.getCharacter(id);
      if (!meta || meta.visibility !== "public") {
        continue;
      }
      if (
        meta.name.toLowerCase().includes(lowered) ||
        (Number.isInteger(numeric) && numeric > 0 && meta.id === numeric) ||
        meta.id === Number(lowered.replace(/^c/i, ""))
      ) {
        results.push(`C${meta.id} ${meta.name}`);
      }
    }
    await safeReply(
      interaction,
      results.length > 0 ? results.join("\n") : "未找到匹配的公开角色。",
      { ephemeral: true },
    );
  }

  private async handleCharacterAdopt(
    interaction: ChatInputCommandInteraction,
    input: { characterId: number; mode: "copy" | "fork" },
  ): Promise<void> {
    const sourceMeta = await this.worldStore.getCharacter(input.characterId);
    if (!sourceMeta) {
      await safeReply(interaction, `角色不存在：C${input.characterId}`, {
        ephemeral: true,
      });
      return;
    }
    const allowed =
      sourceMeta.creatorId === interaction.user.id ||
      sourceMeta.visibility === "public";
    if (!allowed) {
      await safeReply(interaction, "无权限：该角色不是 public。", {
        ephemeral: true,
      });
      return;
    }
    const sourceCard = await this.worldFiles.readCharacterCard(sourceMeta.id);
    if (!sourceCard) {
      await safeReply(interaction, "角色卡缺失（待修复）。", {
        ephemeral: true,
      });
      return;
    }

    const characterId = await this.worldStore.nextCharacterId();
    const nowIso = new Date().toISOString();
    const name = sourceMeta.name.trim() || `Character-${characterId}`;
    await this.worldStore.createCharacter({
      id: characterId,
      creatorId: interaction.user.id,
      name,
      visibility: "private",
      status: "active",
      createdAt: nowIso,
      updatedAt: nowIso,
    });

    const adoptedCard = buildAdoptedCharacterCard({
      adoptedCharacterId: characterId,
      adopterUserId: interaction.user.id,
      mode: input.mode,
      sourceCharacterId: sourceMeta.id,
      sourceCard,
    });
    await this.worldFiles.writeCharacterCard(characterId, adoptedCard);
    await this.worldFiles.appendCharacterEvent(characterId, {
      type: "character_adopted",
      characterId,
      userId: interaction.user.id,
      mode: input.mode,
      sourceCharacterId: sourceMeta.id,
    });
    await this.worldStore.setGlobalActiveCharacter({
      userId: interaction.user.id,
      characterId,
    });

    await safeReply(
      interaction,
      [
        `已创建你的角色：C${characterId} ${name}`,
        `来源：C${sourceMeta.id}（${input.mode}）`,
        `已设为默认角色：/character use character_id:${characterId}`,
      ].join("\n"),
      { ephemeral: true },
    );
  }

  private async resolveCharacterIdForVisibilityCommand(
    interaction: ChatInputCommandInteraction,
    characterId?: number,
  ): Promise<number> {
    if (characterId && Number.isInteger(characterId) && characterId > 0) {
      return characterId;
    }
    const groupId = await this.worldStore.getGroupIdByChannel(
      interaction.channelId,
    );
    const parsed = groupId ? parseCharacterGroup(groupId) : null;
    if (parsed?.kind === "build") {
      return parsed.characterId;
    }
    throw new Error("缺少 character_id：请显式提供，或在角色私密话题中执行。");
  }

  private async resolveJoinCharacterId(input: {
    userId: string;
    explicitCharacterId?: number;
  }): Promise<number> {
    const explicit = input.explicitCharacterId;
    if (explicit && Number.isInteger(explicit) && explicit > 0) {
      const meta = await this.worldStore.getCharacter(explicit);
      if (!meta) {
        throw new Error(`角色不存在：C${explicit}`);
      }
      if (meta.creatorId !== input.userId) {
        throw new Error("无权限：只能使用你自己创建的角色。");
      }
      return meta.id;
    }

    const globalActive = await this.worldStore.getGlobalActiveCharacterId({
      userId: input.userId,
    });
    if (globalActive) {
      const meta = await this.worldStore.getCharacter(globalActive);
      if (meta && meta.creatorId === input.userId) {
        return meta.id;
      }
    }

    const userCharacters = await this.worldStore.listUserCharacterIds(
      input.userId,
      5,
    );
    if (userCharacters.length === 0) {
      throw new Error("你还没有角色卡：请先 /character create。");
    }
    if (userCharacters.length === 1) {
      return userCharacters[0]!;
    }
    throw new Error(
      "你有多个角色：请在 /world join 里提供 character_id，或先用 /character use 设置默认角色。",
    );
  }

  private async ensureWorldSpecificCharacter(input: {
    worldId: number;
    worldName: string;
    userId: string;
    sourceCharacterId: number;
  }): Promise<{
    characterId: number;
    sourceCharacterId: number;
    forked: boolean;
  }> {
    const sourceCharacterId = input.sourceCharacterId;
    const sourceCard =
      await this.worldFiles.readCharacterCard(sourceCharacterId);
    if (sourceCard && hasWorldForkMarker(sourceCard, input.worldId)) {
      return {
        characterId: sourceCharacterId,
        sourceCharacterId,
        forked: false,
      };
    }

    const existingFork = await this.worldStore.getWorldForkedCharacterId({
      worldId: input.worldId,
      userId: input.userId,
      sourceCharacterId,
    });
    if (existingFork) {
      return { characterId: existingFork, sourceCharacterId, forked: false };
    }

    const sourceMeta = await this.worldStore.getCharacter(sourceCharacterId);
    if (!sourceMeta) {
      throw new Error(`角色不存在：C${sourceCharacterId}`);
    }

    const forkedCharacterId = await this.worldStore.nextCharacterId();
    const nowIso = new Date().toISOString();
    const forkName = `${sourceMeta.name}-W${input.worldId}`;

    await this.worldStore.createCharacter({
      id: forkedCharacterId,
      creatorId: input.userId,
      name: forkName,
      visibility: "private",
      status: "active",
      createdAt: nowIso,
      updatedAt: nowIso,
    });

    const forkedCard = buildWorldForkedCharacterCard({
      worldId: input.worldId,
      worldName: input.worldName,
      sourceCharacterId,
      forkedCharacterId,
      creatorId: input.userId,
      sourceCard: sourceCard ?? `# 角色卡（C${forkedCharacterId}）\n`,
    });
    await this.worldFiles.writeCharacterCard(forkedCharacterId, forkedCard);
    await this.worldFiles.appendCharacterEvent(forkedCharacterId, {
      type: "character_world_fork_created",
      worldId: input.worldId,
      worldName: input.worldName,
      sourceCharacterId,
      characterId: forkedCharacterId,
      userId: input.userId,
    });
    await this.worldStore.setWorldForkedCharacterId({
      worldId: input.worldId,
      userId: input.userId,
      sourceCharacterId,
      forkedCharacterId,
    });

    return { characterId: forkedCharacterId, sourceCharacterId, forked: true };
  }

  private async maybeStartWorldCharacterAutoFix(input: {
    worldId: number;
    worldName: string;
    userId: string;
    characterId: number;
  }): Promise<void> {
    const config = getConfig();
    const homeGuildId = config.DISCORD_HOME_GUILD_ID?.trim();
    if (!homeGuildId) {
      return;
    }
    const guild = await this.client.guilds.fetch(homeGuildId).catch(() => null);
    if (!guild) {
      return;
    }

    const meta = await this.worldStore.getCharacter(input.characterId);
    const characterName =
      meta?.name?.trim() || `Character-${input.characterId}`;

    const workshop = await this.createCreatorOnlyChannel({
      guild,
      name: `character-workshop-${input.userId}`,
      creatorUserId: input.userId,
      reason: `character workshop ensure for ${input.userId}`,
    });
    const thread = await this.tryCreatePrivateThread({
      guild,
      parentChannelId: workshop.id,
      name: `世界修正 W${input.worldId} C${input.characterId}`,
      reason: `world character auto-fix W${input.worldId} C${input.characterId}`,
      memberUserId: input.userId,
    });
    if (!thread) {
      return;
    }

    await this.ensureWorldCharacterBuildGroupAgent({
      worldId: input.worldId,
      worldName: input.worldName,
      characterId: input.characterId,
      characterName,
    });
    await this.worldStore.setChannelGroupId(
      thread.threadId,
      buildWorldCharacterBuildGroupId({
        worldId: input.worldId,
        characterId: input.characterId,
      }),
    );

    await this.sendLongTextToChannel({
      guildId: homeGuildId,
      channelId: thread.threadId,
      content: [
        `【世界专用角色卡修正】C${input.characterId}（W${input.worldId}）`,
        `我会尝试根据该世界的 world/rules.md 自动校正角色卡（只改角色卡，不改世界正典）。`,
        `你可以在本私密话题继续补充信息（不需要 @）。`,
      ].join("\n"),
    });

    await this.emitSyntheticWorldCharacterBuildKickoff({
      channelId: thread.threadId,
      userId: input.userId,
      worldId: input.worldId,
      worldName: input.worldName,
      characterId: input.characterId,
      characterName,
    });
  }

  private async handleCharacterClose(
    interaction: ChatInputCommandInteraction,
  ): Promise<void> {
    await safeReply(
      interaction,
      "角色构建私密话题不再需要关闭（永久存在）。如需继续编辑：/character open character_id:<角色ID>。",
      { ephemeral: true },
    );
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

  private async migrateWorldAgents(): Promise<void> {
    const ids = await this.worldStore.listWorldIds(200);
    for (const id of ids) {
      const meta = await this.worldStore.getWorld(id);
      if (!meta) {
        continue;
      }
      try {
        await this.ensureWorldBuildGroupAgent({
          worldId: meta.id,
          worldName: meta.name,
        });
        if (meta.status !== "draft") {
          await this.ensureWorldGroupAgent({
            worldId: meta.id,
            worldName: meta.name,
          });
        }
      } catch (err) {
        this.logger.warn(
          { err, worldId: meta.id, guildId: meta.homeGuildId },
          "Failed to migrate world agents",
        );
      }
    }
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
    guildId?: string;
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
      guildId: input.guildId ?? undefined,
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
    traceId?: string;
  }): Promise<void> {
    const nowIso = new Date().toISOString();
    const [meta, card, rules, stats] = await Promise.all([
      this.worldStore.getWorld(input.worldId),
      this.worldFiles.readWorldCard(input.worldId),
      this.worldFiles.readRules(input.worldId),
      this.worldFiles.readStats(input.worldId),
    ]);
    const creatorLabel =
      meta?.creatorId && meta.creatorId.trim()
        ? await this.resolveDiscordUserLabel({
            userId: meta.creatorId,
            guild: this.client.guilds.cache.get(input.guildId) ?? null,
          })
        : null;
    const joinHint = `加入：/world join world_id:${input.worldId}`;
    const header = [
      `【世界信息】W${input.worldId} ${input.worldName}`,
      `更新时间：${nowIso}`,
      creatorLabel ? `创作者：${creatorLabel}` : null,
      `访客数：${stats.visitorCount} 角色数：${stats.characterCount}`,
      joinHint,
      ``,
    ]
      .filter((line): line is string => Boolean(line))
      .join("\n");

    await this.sendLongTextToChannel({
      guildId: input.guildId,
      channelId: input.infoChannelId,
      content: header,
      traceId: input.traceId,
    });
    await this.sendLongTextToChannel({
      guildId: input.guildId,
      channelId: input.infoChannelId,
      content:
        card?.trim() && meta?.creatorId
          ? patchCreatorLineInMarkdown(
              card.trim(),
              meta.creatorId,
              creatorLabel,
            )
          : card?.trim()
            ? card.trim()
            : "(世界卡缺失)",
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
    guild: Guild;
    worldId: number;
    worldName: string;
    creatorUserId: string;
  }): Promise<{
    roleId: string;
    categoryId: string;
    infoChannelId: string;
    discussionChannelId: string;
    proposalsChannelId: string;
    voiceChannelId: string;
  }> {
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
      creatorUserId: input.creatorUserId,
      botUserId: botId,
    });

    const infoChannel = await input.guild.channels.create({
      name: "world-announcements",
      type: ChannelType.GuildText,
      parent: category.id,
      permissionOverwrites: baseOverwrites.info,
      reason: `world publish by ${input.creatorUserId}`,
    });
    const discussionChannel = await input.guild.channels.create({
      name: "world-discussion",
      type: ChannelType.GuildText,
      parent: category.id,
      permissionOverwrites: baseOverwrites.roleplay,
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
      discussionChannelId: discussionChannel.id,
      proposalsChannelId: proposalsChannel.id,
      voiceChannelId: voiceChannel.id,
    });

    return {
      roleId: role.id,
      categoryId: category.id,
      infoChannelId: infoChannel.id,
      discussionChannelId: discussionChannel.id,
      proposalsChannelId: proposalsChannel.id,
      voiceChannelId: voiceChannel.id,
    };
  }

  private async sendWorldCreateRules(input: {
    guildId?: string;
    channelId: string;
    worldId: number;
    traceId?: string;
  }): Promise<void> {
    await this.sendLongTextToChannel({
      guildId: input.guildId,
      channelId: input.channelId,
      traceId: input.traceId,
      content: [
        `【世界创建规则】（W${input.worldId} 私密会话）`,
        ``,
        `1) 这是一段私密会话：仅你与 bot 可见；你在这里发的任何内容都会被当作“对 bot 的输入”，不需要 @。`,
        `2) 你可以用两种方式提供设定原文：`,
        `   - 直接粘贴/分段发送（多轮对话补全）`,
        `   - 或上传 txt/md（以及可解析的 docx）（会自动写入 world/source.md）`,
        `3) bot 会把设定整理为两份正典文件（可反复修改）：`,
        `   - world/world-card.md（世界背景/势力/地点/历史等）`,
        `   - world/rules.md（硬规则：初始金额/装备/底层逻辑/禁止事项等）`,
        `4) 规则与世界卡是“正典”：没写到的部分允许后续补全，但不要自相矛盾。`,
        `5) 当你确认已经 OK：在本私密话题执行 /world done 发布世界；发布后会创建子空间（公告/讨论/提案）。`,
        `6) 私密会话永久存在：不需要关闭；以后继续修改用 /world open world_id:<世界ID>。`,
        ``,
      ].join("\n"),
    });
  }

  private async sendCharacterCreateRules(input: {
    guildId?: string;
    channelId: string;
    characterId: number;
    traceId?: string;
  }): Promise<void> {
    await this.sendLongTextToChannel({
      guildId: input.guildId,
      channelId: input.channelId,
      traceId: input.traceId,
      content: [
        `【角色卡创建规则】（C${input.characterId} 私密会话）`,
        ``,
        `1) 这是一段私密会话：仅你与 bot 可见；你在这里发的任何内容都会被当作“对 bot 的输入”，不需要 @。`,
        `2) 角色卡文件位于会话工作区：character/character-card.md（可写）。`,
        `3) bot 会把你的描述整理成标准角色卡；如果信息不足，会追问你补充。`,
        `4) 私密会话永久存在：不需要关闭。以后继续修改用 /character open character_id:${input.characterId}。`,
        ``,
      ].join("\n"),
    });
  }

  private async migrateWorldSubspaceChannels(): Promise<void> {
    const ids = await this.worldStore.listWorldIds(200);
    const botId = this.botUserId ?? this.client.user?.id ?? "";
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

      const categoryId = meta.categoryId?.trim() ?? "";
      if (!categoryId) {
        continue;
      }
      const category = await guild.channels.fetch(categoryId).catch(() => null);
      if (!category || category.type !== ChannelType.GuildCategory) {
        continue;
      }

      // Ensure announcements channel name (best-effort).
      try {
        const info = await guild.channels
          .fetch(meta.infoChannelId)
          .catch(() => null);
        if (
          info &&
          info.type === ChannelType.GuildText &&
          info.name !== "world-announcements"
        ) {
          await (
            info as unknown as {
              setName: (name: string, reason?: string) => Promise<unknown>;
            }
          ).setName("world-announcements", "world announcements rename");
        }
      } catch (err) {
        this.logger.warn(
          { err, worldId: meta.id, guildId: meta.homeGuildId },
          "Failed to migrate world announcements channel name",
        );
      }

      // Ensure discussion channel exists (best-effort).
      const cachedDiscussion = guild.channels.cache.find(
        (candidate) =>
          candidate.type === ChannelType.GuildText &&
          candidate.parentId === category.id &&
          candidate.name === "world-discussion",
      );
      try {
        const overwrites = buildWorldBaseOverwrites({
          everyoneRoleId: guild.roles.everyone.id,
          worldRoleId: meta.roleId,
          creatorUserId: meta.creatorId,
          botUserId: botId,
        });
        if (!cachedDiscussion) {
          await guild.channels.create({
            name: "world-discussion",
            type: ChannelType.GuildText,
            parent: category.id,
            permissionOverwrites: overwrites.roleplay,
            reason: `world discussion ensure W${meta.id}`,
          });
          await this.worldFiles.appendEvent(meta.id, {
            type: "world_discussion_channel_created",
            worldId: meta.id,
            guildId: meta.homeGuildId,
          });
        }

        const cachedProposals = guild.channels.cache.find(
          (candidate) =>
            candidate.type === ChannelType.GuildText &&
            candidate.parentId === category.id &&
            candidate.name === "world-proposals",
        );
        if (!cachedProposals) {
          await guild.channels.create({
            name: "world-proposals",
            type: ChannelType.GuildText,
            parent: category.id,
            permissionOverwrites: overwrites.proposals,
            reason: `world proposals ensure W${meta.id}`,
          });
          await this.worldFiles.appendEvent(meta.id, {
            type: "world_proposals_channel_created",
            worldId: meta.id,
            guildId: meta.homeGuildId,
          });
        }
      } catch (err) {
        this.logger.warn(
          { err, worldId: meta.id, guildId: meta.homeGuildId },
          "Failed to migrate world subspace channels",
        );
      }
    }
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
    characterId: number;
    characterName: string;
  }): Promise<void> {
    const groupId = buildCharacterBuildGroupId(input.characterId);
    const groupPath = await this.groupRepository.ensureGroupDir(groupId);
    const agentPath = path.join(groupPath, "agent.md");
    const content = buildCharacterBuildAgentPrompt(input);
    await atomicWrite(agentPath, content);
  }

  private async ensureWorldCharacterBuildGroupAgent(input: {
    worldId: number;
    worldName: string;
    characterId: number;
    characterName: string;
  }): Promise<void> {
    const groupId = buildWorldCharacterBuildGroupId({
      worldId: input.worldId,
      characterId: input.characterId,
    });
    const groupPath = await this.groupRepository.ensureGroupDir(groupId);
    const agentPath = path.join(groupPath, "agent.md");
    const content = buildWorldCharacterBuildAgentPrompt(input);
    await atomicWrite(agentPath, content);
  }

  private async emitSyntheticWorldBuildKickoff(input: {
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
      `2) 回复包含：变更摘要 +（如信息不足）3-5 个需要创作者补充的问题；如果信息已足够则明确说明“已 OK，可发布”。`,
      `3) 不要 roleplay，不要编造未给出的设定。`,
      `4) 禁止使用任何交互式提问工具（例如 question）；需要补充信息请直接用文字列出问题。`,
      ``,
      `提示：创作者完成后在本私密话题中执行 /world done 发布世界。`,
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
      guildId: undefined,
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
        guildId: undefined,
        userId: input.userId,
      },
    } satisfies SessionEvent<DiscordInteractionExtras>);
  }

  private async emitSyntheticCharacterBuildKickoff(input: {
    channelId: string;
    userId: string;
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
      `请完善并更新：`,
      `- character/character-card.md（本角色卡，可写）`,
      ``,
      `请使用技能 character-card 完善并更新 character/character-card.md。`,
      ``,
      `要求：`,
      `1) 必须通过工具写入/编辑文件，不能只在聊天里输出。`,
      `2) 回复包含：变更摘要 +（如信息不足）3-5 个需要创作者补充的问题；如果信息已足够则明确说明“已 OK”。`,
      `3) 禁止使用任何交互式提问工具（例如 question）；需要补充信息请直接用文字列出问题。`,
      ``,
      `角色：C${input.characterId} ${input.characterName}`,
    ].join("\n");

    const messageId = `synthetic-character-build-${Date.now()}-${Math.random()
      .toString(16)
      .slice(2)}`;
    await this.emitEvent({
      type: "message",
      platform: "discord",
      selfId: botId,
      userId: input.userId,
      guildId: undefined,
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
        guildId: undefined,
        userId: input.userId,
      },
    } satisfies SessionEvent<DiscordInteractionExtras>);
  }

  private async emitSyntheticWorldCharacterBuildKickoff(input: {
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
      `你现在在“世界专用角色卡修正”模式。`,
      `目标：让角色卡尽量贴合当前世界的正典与规则。`,
      ``,
      `请读取：`,
      `- world/world-card.md（世界正典，只读）`,
      `- world/rules.md（世界规则，只读）`,
      ``,
      `并更新：`,
      `- character/character-card.md（本角色卡，可写）`,
      ``,
      `要求：`,
      `1) 必须通过工具写入/编辑文件，不能只在聊天里输出。`,
      `2) 禁止修改 world/world-card.md 与 world/rules.md（它们只读）。`,
      `3) 回复包含：变更摘要 +（如信息不足）3-5 个需要创作者补充的问题；如果信息已足够则明确说明“已 OK”。`,
      `4) 你不是来写小说的，不要 roleplay，不要替用户发言。`,
      ``,
      `世界：W${input.worldId} ${input.worldName}`,
      `角色：C${input.characterId} ${input.characterName}`,
    ].join("\n");

    const messageId = `synthetic-world-character-build-${Date.now()}-${Math.random()
      .toString(16)
      .slice(2)}`;
    await this.emitEvent({
      type: "message",
      platform: "discord",
      selfId: botId,
      userId: input.userId,
      guildId: undefined,
      channelId: input.channelId,
      messageId,
      content,
      elements: [{ type: "text", text: content }],
      timestamp: Date.now(),
      extras: {
        traceId: input.traceId,
        synthetic: true,
        interactionId: messageId,
        commandName: "character.world_fork.kickoff",
        channelId: input.channelId,
        guildId: undefined,
        userId: input.userId,
      },
    } satisfies SessionEvent<DiscordInteractionExtras>);
  }

  private async resolveDiscordUserLabel(input: {
    userId: string;
    guild?: Guild | null;
  }): Promise<string> {
    const userId = input.userId.trim();
    if (!userId) {
      return "";
    }
    const mention = `<@${userId}>`;

    const guild = input.guild ?? null;
    if (guild) {
      const member = await guild.members.fetch(userId).catch(() => null);
      const displayName = member?.displayName?.trim() ?? "";
      if (displayName) {
        return `${mention}（${displayName}）`;
      }
    }

    const user = await this.client.users.fetch(userId).catch(() => null);
    const name = (user?.globalName ?? user?.username ?? "").trim();
    return name ? `${mention}（${name}）` : mention;
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

function patchCreatorLineInMarkdown(
  input: string,
  creatorId: string,
  creatorLabel: string | null,
): string {
  const trimmed = input.trim();
  if (!trimmed) {
    return input;
  }
  const safeCreatorId = creatorId.trim();
  if (!safeCreatorId) {
    return input;
  }
  const label = (creatorLabel ?? `<@${safeCreatorId}>`).trim();

  const lines = trimmed.split("\n");
  let patched = false;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const match = line.match(/^\s*-\s*创建者\s*[:：]\s*(.+)\s*$/);
    if (!match) {
      continue;
    }
    const value = match[1]?.trim() ?? "";
    if (
      !value ||
      value === safeCreatorId ||
      value === `<@${safeCreatorId}>` ||
      /^\d+$/.test(value) ||
      value.includes(safeCreatorId)
    ) {
      lines[i] = `- 创建者：${label}`;
      patched = true;
    }
  }
  return patched ? lines.join("\n") : input;
}

function buildSlashCommands() {
  return [
    new SlashCommandBuilder()
      .setName("onboard")
      .setDescription("新手引导：选择身份并接收私信规则")
      .addStringOption((option) =>
        option
          .setName("role")
          .setDescription("身份")
          .addChoices(
            { name: "player", value: "player" },
            { name: "creator", value: "creator" },
          )
          .setRequired(true),
      )
      .toJSON(),
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
        sub.setName("help").setDescription("查看世界系统指令用法"),
      )
      .addSubcommand((sub) =>
        sub
          .setName("create")
          .setDescription(
            "创建世界（进入私密话题，多轮补全；/world done 发布）",
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName("open")
          .setDescription("打开该世界的私密编辑话题（仅创作者）")
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
          .setName("done")
          .setDescription("发布当前草稿世界（仅创作者，在私密话题中执行）"),
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
              .setDescription("世界ID（在世界子空间频道内可省略）")
              .setMinValue(1)
              .setRequired(false),
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName("rules")
          .setDescription("查看世界规则")
          .addIntegerOption((option) =>
            option
              .setName("world_id")
              .setDescription("世界ID（在世界子空间频道内可省略）")
              .setMinValue(1)
              .setRequired(false),
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
          .setName("submit")
          .setDescription(
            "提交提案/任务/正典（写入 world-proposals，待创作者确认）",
          )
          .addStringOption((option) =>
            option
              .setName("kind")
              .setDescription("类型")
              .addChoices(
                { name: "canon", value: "canon" },
                { name: "chronicle", value: "chronicle" },
                { name: "task", value: "task" },
                { name: "news", value: "news" },
              )
              .setRequired(true),
          )
          .addStringOption((option) =>
            option
              .setName("title")
              .setDescription("标题")
              .setMinLength(1)
              .setMaxLength(80)
              .setRequired(true),
          )
          .addStringOption((option) =>
            option
              .setName("content")
              .setDescription("内容（可简要；复杂内容建议先整理成文本再提交）")
              .setMinLength(1)
              .setMaxLength(2000)
              .setRequired(true),
          )
          .addIntegerOption((option) =>
            option
              .setName("world_id")
              .setDescription("世界ID（在世界子空间频道内可省略）")
              .setMinValue(1)
              .setRequired(false),
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName("approve")
          .setDescription("创作者确认并写入正典/任务/编年史")
          .addIntegerOption((option) =>
            option
              .setName("submission_id")
              .setDescription("提交ID")
              .setMinValue(1)
              .setRequired(true),
          )
          .addIntegerOption((option) =>
            option
              .setName("world_id")
              .setDescription("世界ID（在世界子空间频道内可省略）")
              .setMinValue(1)
              .setRequired(false),
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName("check")
          .setDescription("检查/搜索世界正典与提案是否包含某关键词")
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
              .setDescription("世界ID（在世界子空间频道内可省略）")
              .setMinValue(1)
              .setRequired(false),
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName("join")
          .setDescription("加入世界（获得发言权限）")
          .addIntegerOption((option) =>
            option
              .setName("world_id")
              .setDescription("世界ID（在世界子空间频道内可省略）")
              .setMinValue(1)
              .setRequired(false),
          )
          .addIntegerOption((option) =>
            option
              .setName("character_id")
              .setDescription("角色ID（可选；默认使用你的当前角色）")
              .setMinValue(1)
              .setRequired(false),
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName("stats")
          .setDescription("查看世界统计")
          .addIntegerOption((option) =>
            option
              .setName("world_id")
              .setDescription("世界ID（在世界子空间频道内可省略）")
              .setMinValue(1)
              .setRequired(false),
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName("status")
          .setDescription("查看世界状态（同 stats）")
          .addIntegerOption((option) =>
            option
              .setName("world_id")
              .setDescription("世界ID（在世界子空间频道内可省略）")
              .setMinValue(1)
              .setRequired(false),
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
          .setName("remove")
          .setDescription("移除世界（管理员）")
          .addIntegerOption((option) =>
            option
              .setName("world_id")
              .setDescription("世界ID")
              .setMinValue(1)
              .setRequired(true),
          ),
      )
      .toJSON(),
    new SlashCommandBuilder()
      .setName("character")
      .setDescription("角色系统")
      .addSubcommand((sub) =>
        sub
          .setName("create")
          .setDescription("创建角色卡（进入私密话题，多轮补全）")
          .addStringOption((option) =>
            option
              .setName("name")
              .setDescription("角色名（可选；也可在私密话题中补全）")
              .setRequired(false),
          )
          .addStringOption((option) =>
            option
              .setName("visibility")
              .setDescription("可见性（默认 private）")
              .addChoices(
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
          .setName("open")
          .setDescription("打开该角色的私密编辑话题（仅创作者）")
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
          .setDescription("设置你在本世界的当前角色")
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
          .setName("use")
          .setDescription("设置你的默认角色（全局）")
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
          .setName("publish")
          .setDescription("将角色设为公开（public 才能被 list/search）")
          .addIntegerOption((option) =>
            option
              .setName("character_id")
              .setDescription("角色ID（可省略：在私密话题中会取当前角色）")
              .setMinValue(1)
              .setRequired(false),
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName("unpublish")
          .setDescription("将角色设为私密（private）")
          .addIntegerOption((option) =>
            option
              .setName("character_id")
              .setDescription("角色ID（可省略：在私密话题中会取当前角色）")
              .setMinValue(1)
              .setRequired(false),
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName("list")
          .setDescription("列出我的角色")
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
          .setName("search")
          .setDescription("搜索公开角色（public）")
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
          .setName("adopt")
          .setDescription(
            "使用公开角色：复制或 fork 为你的角色（默认设为私密）",
          )
          .addIntegerOption((option) =>
            option
              .setName("character_id")
              .setDescription("公开角色ID")
              .setMinValue(1)
              .setRequired(true),
          )
          .addStringOption((option) =>
            option
              .setName("mode")
              .setDescription("模式")
              .addChoices(
                { name: "copy", value: "copy" },
                { name: "fork", value: "fork" },
              )
              .setRequired(true),
          ),
      )
      .toJSON(),
  ];
}

function buildWorldBaseOverwrites(input: {
  everyoneRoleId: string;
  worldRoleId: string;
  creatorUserId: string;
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
  const useCommands = PermissionFlagsBits.UseApplicationCommands;
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

  const allowCreator =
    input.creatorUserId && input.creatorUserId.trim()
      ? [
          {
            id: input.creatorUserId,
            allow: [view, readHistory, send, sendInThreads],
          },
        ]
      : [];

  const everyoneReadOnly = {
    id: input.everyoneRoleId,
    allow: [view, readHistory, useCommands],
    deny: [send],
  };
  const worldReadOnly = {
    id: input.worldRoleId,
    allow: [view, readHistory, useCommands],
    deny: [send],
  };
  const worldWritable = {
    id: input.worldRoleId,
    allow: [view, readHistory, useCommands, send, sendInThreads],
  };

  return {
    info: [everyoneReadOnly, worldReadOnly, ...allowCreator, ...allowBot],
    join: [everyoneReadOnly, worldWritable, ...allowBot],
    roleplay: [everyoneReadOnly, worldWritable, ...allowBot],
    proposals: [everyoneReadOnly, worldWritable, ...allowBot],
    voice: [
      { id: input.everyoneRoleId, allow: [view], deny: [connect, speak] },
      { id: input.worldRoleId, allow: [view, connect, speak] },
    ],
  };
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

function buildRulesText(role: UserRole): string {
  if (role === "creator") {
    return [
      `【世界创建者规则】`,
      ``,
      `你将以“世界创建者”的身份工作。`,
      ``,
      `流程：`,
      `1) 在 homeGuild 执行 /world create（如无权限请联系管理员开放 createPolicy）。`,
      `2) 系统会创建一个“世界构建私密话题”（仅你与 bot 可见），你可以：粘贴设定原文/上传 txt|md|docx。`,
      `3) bot 会把原文整理为：world/world-card.md 与 world/rules.md。`,
      `4) 确认无误后执行 /world done 发布世界（创建公告/讨论/提案区并自动拉你加入）。`,
      ``,
      `提示：`,
      `- 私密话题长期存在；后续可用 /world open world_id:<ID> 打开对应世界继续编辑。`,
    ].join("\n");
  }

  return [
    `【玩家规则】`,
    ``,
    `你将以“玩家”的身份游玩。`,
    ``,
    `流程：`,
    `1) 创建角色卡：/character create（会创建一个私密话题，多轮补全）。`,
    `2) 选择世界：用 /world list 或 /world search 找到世界 ID。`,
    `3) 查看世界：/world info world_id:<ID>（可看到世界名、一句话简介、规则等）。`,
    `4) 加入世界：/world join world_id:<ID>（加入后你才有发言权限）。`,
    `5) 设置你在该世界的当前角色：/character act character_id:<ID>（世界内执行）。`,
    ``,
    `提示：`,
    `- 你可以创建多张角色卡，也可以加入多个世界。`,
    `- 角色卡可设为 public 供他人检索（/character publish）。`,
  ].join("\n");
}

function buildWorldAgentPrompt(input: {
  worldId: number;
  worldName: string;
}): string {
  return [
    `---`,
    `name: World-${input.worldId}`,
    `version: "1"`,
    `---`,
    ``,
    `你在 Discord 世界系统中工作。当前世界：W${input.worldId} ${input.worldName}。`,
    ``,
    `硬性规则：`,
    `1) 世界正典与规则在会话工作区的 \`world/world-card.md\` 与 \`world/rules.md\`。回答前必须读取它们；不确定就说不知道，禁止编造。`,
    `2) 如果 \`world/active-character.md\` 存在：这代表用户正在以该角色身份发言。你作为旁白/世界系统/GM回应，禁止替用户发言，更不能用第一人称扮演用户角色。`,
    `3) 当前是游玩会话（只读）。当用户请求修改世界设定/正典时：不要直接改写文件；应引导联系世界创作者在私密会话中执行 /world open world_id:${input.worldId} 后修改，并用 /world done 发布更新。`,
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
    `version: "1"`,
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
    `4) 禁止使用任何交互式提问工具（例如 question）；需要补充信息请直接在回复里列出问题。`,
    `5) 你不是来写小说的，不要 roleplay。`,
    ``,
    `提示：你可以使用技能 \`world-design-card\` 来统一模板与字段。`,
    ``,
  ].join("\n");
}

function buildCharacterBuildAgentPrompt(input: {
  characterId: number;
  characterName: string;
}): string {
  return [
    `---`,
    `name: Character-${input.characterId}-Build`,
    `version: "1"`,
    `---`,
    ``,
    `你在 Discord 世界系统中工作，当前是“角色卡创作/整理”模式：C${input.characterId} ${input.characterName}。`,
    ``,
    `目标：把角色设定规范化为可用的角色卡，并持续补全。`,
    ``,
    `硬性规则：`,
    `1) 角色卡产物必须写入：\`character/character-card.md\`。你必须使用工具写入/编辑文件，禁止只在回复里输出。`,
    `2) 每次回复都包含：变更摘要 +（如信息不足）3-5 个需要创作者补充的问题；如果信息已足够则明确说明“已 OK”。`,
    `3) 禁止使用任何交互式提问工具（例如 question）；需要补充信息请直接在回复里列出问题。`,
    `4) 你不是来写小说的，不要 roleplay。`,
    ``,
    `提示：你可以使用技能 \`character-card\` 来统一模板与字段。`,
    ``,
  ].join("\n");
}

function buildWorldCharacterBuildAgentPrompt(input: {
  worldId: number;
  worldName: string;
  characterId: number;
  characterName: string;
}): string {
  return [
    `---`,
    `name: World-${input.worldId}-Character-${input.characterId}-Build`,
    `version: "1"`,
    `---`,
    ``,
    `你在 Discord 世界系统中工作，当前是“世界专用角色卡修正”模式。`,
    ``,
    `世界：W${input.worldId} ${input.worldName}`,
    `角色：C${input.characterId} ${input.characterName}`,
    ``,
    `硬性规则：`,
    `1) 必须读取：\`world/world-card.md\` 与 \`world/rules.md\`（只读）。`,
    `2) 必须写入：\`character/character-card.md\`（可写）。`,
    `3) 禁止修改 world 文件；即使你修改了也不会被保存。`,
    `4) 每次回复都包含：变更摘要 +（如信息不足）3-5 个需要创作者补充的问题；如果信息已足够则明确说明“已 OK”。`,
    `5) 你不是来写小说的，不要 roleplay。`,
    ``,
    `提示：你可以使用技能 \`character-card\` 来统一模板与字段。`,
    ``,
  ].join("\n");
}

function buildDefaultCharacterCard(input: {
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

function hasWorldForkMarker(card: string, worldId: number): boolean {
  if (!Number.isInteger(worldId) || worldId <= 0) {
    return false;
  }
  const head = card.slice(0, 800);
  const lowered = head.toLowerCase();
  if (!lowered.includes("bot-agent:world_fork")) {
    return false;
  }
  return (
    lowered.includes(`worldid=${String(worldId)}`) ||
    lowered.includes(`worldid:${String(worldId)}`)
  );
}

function buildWorldForkedCharacterCard(input: {
  worldId: number;
  worldName: string;
  sourceCharacterId: number;
  forkedCharacterId: number;
  creatorId: string;
  sourceCard: string;
}): string {
  const marker = `<!-- bot-agent:world_fork worldId=${input.worldId} sourceCharacterId=${input.sourceCharacterId} forkedCharacterId=${input.forkedCharacterId} -->`;
  const patched = patchCharacterCardId(
    input.sourceCard,
    input.forkedCharacterId,
  );
  return [
    marker,
    `# 角色卡（C${input.forkedCharacterId}）`,
    ``,
    `- 世界：W${input.worldId} ${input.worldName}`,
    `- 来源：fork 自 C${input.sourceCharacterId}`,
    `- 创建者：${input.creatorId}`,
    ``,
    stripLeadingCharacterHeader(patched),
  ]
    .join("\n")
    .trimEnd();
}

function buildAdoptedCharacterCard(input: {
  adoptedCharacterId: number;
  adopterUserId: string;
  mode: "copy" | "fork";
  sourceCharacterId: number;
  sourceCard: string;
}): string {
  const marker = `<!-- bot-agent:character_adopt mode=${input.mode} sourceCharacterId=${input.sourceCharacterId} adoptedCharacterId=${input.adoptedCharacterId} -->`;
  const patched = patchCharacterCardId(
    input.sourceCard,
    input.adoptedCharacterId,
  );
  return [
    marker,
    `# 角色卡（C${input.adoptedCharacterId}）`,
    ``,
    `- 来源：C${input.sourceCharacterId}（${input.mode}）`,
    `- 采用者：${input.adopterUserId}`,
    ``,
    stripLeadingCharacterHeader(patched),
  ]
    .join("\n")
    .trimEnd();
}

function patchCharacterCardId(card: string, characterId: number): string {
  if (!Number.isInteger(characterId) || characterId <= 0) {
    return card;
  }
  const normalized = card.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const lines = normalized.split("\n");
  for (let i = 0; i < Math.min(lines.length, 20); i += 1) {
    const line = lines[i] ?? "";
    if (line.match(/^#\s*角色卡/)) {
      lines[i] = `# 角色卡（C${characterId}）`;
      return lines.join("\n");
    }
  }
  return normalized;
}

function stripLeadingCharacterHeader(card: string): string {
  const normalized = card.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
  if (!normalized) {
    return "";
  }
  const lines = normalized.split("\n");
  let idx = 0;
  while (idx < lines.length && lines[idx]?.trim() === "") {
    idx += 1;
  }
  if (idx < lines.length && lines[idx]?.trim().startsWith("# 角色卡")) {
    idx += 1;
    while (idx < lines.length && lines[idx]?.trim() === "") {
      idx += 1;
    }
  }
  return lines.slice(idx).join("\n").trimEnd();
}

function buildWorldSubmissionMarkdown(input: {
  worldId: number;
  worldName: string;
  submissionId: number;
  kind: "canon" | "chronicle" | "task" | "news";
  title: string;
  content: string;
  submitterUserId: string;
  createdAt: string;
}): string {
  const title = input.title.trim();
  const content = input.content.trim();
  const submitter = input.submitterUserId.trim();
  return [
    `# 世界提案（W${input.worldId} / S${input.submissionId}）`,
    ``,
    `- 世界：W${input.worldId} ${input.worldName}`,
    `- 类型：${input.kind}`,
    `- 标题：${title || "(未命名)"}`,
    submitter ? `- 提交者：<@${submitter}>` : null,
    `- 时间：${input.createdAt}`,
    ``,
    `## 内容`,
    content || "(空)",
    ``,
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n");
}

function parseWorldSubmissionMarkdown(content: string): {
  kind?: "canon" | "chronicle" | "task" | "news";
  title?: string;
  submitterUserId?: string;
  content?: string;
} | null {
  const normalized = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const lines = normalized.split("\n");
  let kind: "canon" | "chronicle" | "task" | "news" | undefined;
  let title: string | undefined;
  let submitterUserId: string | undefined;
  let contentStart = -1;
  for (let i = 0; i < Math.min(lines.length, 80); i += 1) {
    const line = (lines[i] ?? "").trim();
    if (!line) continue;
    const kindMatch = line.match(/^-\s*类型：\s*(\w+)\s*$/);
    if (kindMatch) {
      const raw = kindMatch[1]?.trim();
      if (
        raw === "canon" ||
        raw === "chronicle" ||
        raw === "task" ||
        raw === "news"
      ) {
        kind = raw;
      }
      continue;
    }
    const titleMatch = line.match(/^-\s*标题：\s*(.+)$/);
    if (titleMatch) {
      title = titleMatch[1]?.trim() || undefined;
      continue;
    }
    const submitterMatch = line.match(/^-\s*提交者：\s*<@(\d+)>\s*$/);
    if (submitterMatch) {
      submitterUserId = submitterMatch[1]?.trim() || undefined;
      continue;
    }
    if (line === "## 内容") {
      contentStart = i + 1;
      break;
    }
  }

  const body =
    contentStart >= 0 ? lines.slice(contentStart).join("\n").trim() : undefined;

  return { kind, title, submitterUserId, content: body };
}

function extractWorldOneLiner(card: string | null): string | null {
  const raw = (card ?? "").trim();
  if (!raw) return null;
  const normalized = raw.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const match = normalized.match(/^-\\s*一句话简介：\\s*(.+)\\s*$/m);
  const summary = match?.[1]?.trim() ?? "";
  if (!summary) return null;
  return summary.length > 80 ? `${summary.slice(0, 80)}…` : summary;
}

function extractWorldNameFromCard(card: string | null): string | null {
  const raw = (card ?? "").trim();
  if (!raw) return null;
  const normalized = raw.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const match = normalized.match(/^-\\s*世界名称：\\s*(.+)\\s*$/m);
  const name = match?.[1]?.trim() ?? "";
  if (!name) return null;
  return name.length > 60 ? name.slice(0, 60) : name;
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
    if (interaction.replied) {
      await interaction.followUp({ content, ephemeral: options.ephemeral });
      return;
    }
    if (interaction.deferred) {
      await interaction.editReply({ content });
      return;
    }
    await interaction.reply({ content, ephemeral: options.ephemeral });
  } catch {
    // ignore
  }
}

async function safeDefer(
  interaction: ChatInputCommandInteraction,
  options: { ephemeral: boolean },
): Promise<void> {
  try {
    if (interaction.replied || interaction.deferred) {
      return;
    }
    await interaction.deferReply({ ephemeral: options.ephemeral });
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
