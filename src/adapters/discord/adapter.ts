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
import type { BotMessageStore } from "../../store/bot-message-store";
import { WorldStore, type CharacterVisibility } from "../../world/store";
import { WorldFileStore } from "../../world/file-store";
import { buildWorldGroupId } from "../../world/ids";
import { getConfig } from "../../config";
import { GroupFileRepository } from "../../store/repository";
import path from "node:path";
import { writeFile, mkdir, rename } from "node:fs/promises";

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
      await safeReply(interaction, "pong", { ephemeral: true });
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

      const key = interaction.options.getInteger("key");
      const targetUser = interaction.options.getUser("user");
      const content = key !== null ? `#${key} /reset` : "/reset";

      await safeReply(interaction, "收到，正在重置对话…", { ephemeral: true });

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

      const key = interaction.options.getInteger("key");
      const content = key !== null ? `#${key} /reset all` : "/reset all";

      await safeReply(interaction, "收到，正在重置全群对话…", {
        ephemeral: true,
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

      const name = interaction.options.getString("name", true).trim();
      const content = `/model ${name}`;

      await safeReply(interaction, "收到，正在切换模型…", { ephemeral: true });

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
      ephemeral: true,
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
    if (subcommand === "join") {
      const worldId = interaction.options.getInteger("world_id", true);
      await this.handleWorldJoin(interaction, worldId);
      return;
    }
    if (subcommand === "stats") {
      const worldId = interaction.options.getInteger("world_id", true);
      await this.handleWorldStats(interaction, worldId);
      return;
    }
    await safeReply(interaction, `未知子命令：/world ${subcommand}`, {
      ephemeral: true,
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
    const worldName = interaction.options.getString("name", true).trim();
    if (!worldName) {
      await safeReply(interaction, "世界名称不能为空。", { ephemeral: true });
      return;
    }

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
      await safeReply(
        interaction,
        `无权限：当前 createPolicy=${policy}（默认 admin）。`,
        { ephemeral: true },
      );
      return;
    }

    const guild = interaction.guild;
    const nowIso = new Date().toISOString();

    await safeReply(interaction, "收到，正在创建世界…", { ephemeral: true });

    const worldId = await this.worldStore.nextWorldId();
    const role = await guild.roles.create({
      name: `World-${worldId}`,
      reason: `world create by ${interaction.user.id}`,
    });

    const category = await guild.channels.create({
      name: `[W${worldId}] ${worldName}`,
      type: ChannelType.GuildCategory,
      reason: `world create by ${interaction.user.id}`,
    });

    const botId = this.botUserId ?? "";
    const baseOverwrites = buildWorldBaseOverwrites({
      everyoneRoleId: guild.roles.everyone.id,
      worldRoleId: role.id,
      botUserId: botId,
    });

    const infoChannel = await guild.channels.create({
      name: "world-info",
      type: ChannelType.GuildText,
      parent: category.id,
      permissionOverwrites: baseOverwrites.info,
      reason: `world create by ${interaction.user.id}`,
    });
    const roleplayChannel = await guild.channels.create({
      name: "world-roleplay",
      type: ChannelType.GuildText,
      parent: category.id,
      permissionOverwrites: baseOverwrites.roleplay,
      reason: `world create by ${interaction.user.id}`,
    });
    const proposalsChannel = await guild.channels.create({
      name: "world-proposals",
      type: ChannelType.GuildText,
      parent: category.id,
      permissionOverwrites: baseOverwrites.proposals,
      reason: `world create by ${interaction.user.id}`,
    });
    const voiceChannel = await guild.channels.create({
      name: "World Voice",
      type: ChannelType.GuildVoice,
      parent: category.id,
      permissionOverwrites: baseOverwrites.voice,
      reason: `world create by ${interaction.user.id}`,
    });

    await this.worldStore.createWorld({
      id: worldId,
      homeGuildId: interaction.guildId,
      creatorId: interaction.user.id,
      name: worldName,
      status: "active",
      createdAt: nowIso,
      updatedAt: nowIso,
      roleId: role.id,
      categoryId: category.id,
      infoChannelId: infoChannel.id,
      roleplayChannelId: roleplayChannel.id,
      proposalsChannelId: proposalsChannel.id,
      voiceChannelId: voiceChannel.id,
    });

    await this.worldFiles.ensureDefaultFiles({
      worldId,
      worldName,
      creatorId: interaction.user.id,
    });
    await this.worldFiles.appendEvent(worldId, {
      type: "world_created",
      worldId,
      guildId: interaction.guildId,
      userId: interaction.user.id,
    });

    await this.ensureWorldGroupAgent({
      worldId,
      worldName,
    });

    const member = await guild.members.fetch(interaction.user.id);
    await member.roles.add(role.id, "world creator auto-join");
    await this.worldStore.addMember(worldId, interaction.user.id);

    await safeReply(
      interaction,
      [
        `世界已创建：W${worldId} ${worldName}`,
        `入口：<#${roleplayChannel.id}>`,
        `只读信息：<#${infoChannel.id}>`,
        `加入指令：/world join world_id:${worldId}`,
      ].join("\n"),
      { ephemeral: true },
    );

    const intro = [
      `世界已创建：W${worldId} ${worldName}`,
      `- 加入：/world join world_id:${worldId}`,
      `- 统计：/world stats world_id:${worldId}`,
      `- 角色：/character create (在 <#${roleplayChannel.id}> 内可省略 world_id)`,
    ].join("\n");
    await (infoChannel as { send: (content: string) => Promise<unknown> }).send(
      intro,
    );
  }

  private async handleWorldHelp(
    interaction: ChatInputCommandInteraction,
  ): Promise<void> {
    await safeReply(
      interaction,
      [
        "世界系统指令：",
        "- /world create name:<世界名称>（默认仅管理员；可配置 world.createPolicy）",
        "- /world list [limit:<1-100>]",
        "- /world info world_id:<世界ID>",
        "- /world rules world_id:<世界ID>",
        "- /world join world_id:<世界ID>（必须在入口服务器执行以赋予 World-<id> 角色）",
        "- /world stats world_id:<世界ID>",
        "",
        "提示：",
        "- 世界入口频道为 world-roleplay；加入后可在该频道直接对话",
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
      await safeReply(interaction, "暂无世界。", { ephemeral: true });
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
    await safeReply(interaction, lines.join("\n"), { ephemeral: true });
  }

  private async handleWorldInfo(
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
    const card = await this.worldFiles.readWorldCard(meta.id);
    const header = [
      `W${meta.id} ${meta.name}`,
      `入口 guild:${meta.homeGuildId}`,
      `访客数：${await this.worldStore.memberCount(meta.id)}`,
      `角色数：${await this.worldStore.characterCount(meta.id)}`,
      ``,
    ].join("\n");
    const body = card?.trim() ? card.trim() : "(世界卡缺失)";
    await replyLongText(interaction, `${header}${body}`, { ephemeral: true });
  }

  private async handleWorldRules(
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
    const rules = await this.worldFiles.readRules(meta.id);
    const body = rules?.trim() ? rules.trim() : "(规则缺失)";
    await replyLongText(interaction, body, { ephemeral: true });
  }

  private async handleWorldJoin(
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
    const member = await interaction.guild.members.fetch(interaction.user.id);
    await member.roles.add(meta.roleId, "world join");
    const added = await this.worldStore.addMember(meta.id, interaction.user.id);
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
  }

  private async handleWorldStats(
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
    const [members, characters] = await Promise.all([
      this.worldStore.memberCount(meta.id),
      this.worldStore.characterCount(meta.id),
    ]);
    await safeReply(
      interaction,
      `W${meta.id} ${meta.name}\n访客数：${members}\n角色数：${characters}`,
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
    await safeReply(interaction, `未知子命令：/character ${subcommand}`, {
      ephemeral: true,
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
        { ephemeral: true },
      );
      return;
    }
    const world = await this.worldStore.getWorld(worldId);
    if (!world) {
      await safeReply(interaction, `世界不存在：W${worldId}`, {
        ephemeral: true,
      });
      return;
    }
    const isMember = await this.worldStore.isMember(
      world.id,
      interaction.user.id,
    );
    if (!isMember) {
      await safeReply(
        interaction,
        `你尚未加入该世界：请先 /world join world_id:${world.id}`,
        { ephemeral: true },
      );
      return;
    }
    const name = interaction.options.getString("name", true).trim();
    if (!name) {
      await safeReply(interaction, "角色名不能为空。", { ephemeral: true });
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
    await safeReply(
      interaction,
      `角色已创建：C${characterId} ${name}（visibility=${visibility}）\n使用 /character act character_id:${characterId} 让 bot 扮演该角色。`,
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
        "- /character create name:<角色名> [world_id:<世界ID>] [visibility:world|public|private] [description:<补充>]",
        "  - 在世界入口频道（world-roleplay）内可省略 world_id",
        "  - visibility 默认 world",
        "- /character view character_id:<角色ID>（遵循 visibility 权限）",
        "- /character act character_id:<角色ID>（让 bot 在该世界扮演此角色）",
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
        ephemeral: true,
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
      await safeReply(interaction, "无权限查看该角色卡。", { ephemeral: true });
      return;
    }
    const card = await this.worldFiles.readCharacterCard(meta.worldId, meta.id);
    if (!card) {
      await safeReply(interaction, "角色卡缺失（待修复）。", {
        ephemeral: true,
      });
      return;
    }
    await replyLongText(interaction, card.trim(), { ephemeral: true });
  }

  private async handleCharacterAct(
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
    const isMember = await this.worldStore.isMember(
      meta.worldId,
      interaction.user.id,
    );
    if (!isMember) {
      await safeReply(interaction, "你尚未加入该世界，无法指定扮演角色。", {
        ephemeral: true,
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
      { ephemeral: true },
    );
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
          .setDescription("创建世界（默认仅管理员）")
          .addStringOption((option) =>
            option.setName("name").setDescription("世界名称").setRequired(true),
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
          .setName("join")
          .setDescription("加入世界（需在入口服务器执行）")
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
      .toJSON(),
  ];
}

function buildWorldBaseOverwrites(input: {
  everyoneRoleId: string;
  worldRoleId: string;
  botUserId: string;
}): {
  info: Array<{ id: string; allow?: bigint[]; deny?: bigint[] }>;
  roleplay: Array<{ id: string; allow?: bigint[]; deny?: bigint[] }>;
  proposals: Array<{ id: string; allow?: bigint[]; deny?: bigint[] }>;
  voice: Array<{ id: string; allow?: bigint[]; deny?: bigint[] }>;
} {
  const view = PermissionFlagsBits.ViewChannel;
  const readHistory = PermissionFlagsBits.ReadMessageHistory;
  const send = PermissionFlagsBits.SendMessages;
  const connect = PermissionFlagsBits.Connect;
  const speak = PermissionFlagsBits.Speak;

  const allowBot =
    input.botUserId && input.botUserId.trim()
      ? [{ id: input.botUserId, allow: [view, readHistory, send] }]
      : [];

  const everyoneReadOnly = {
    id: input.everyoneRoleId,
    allow: [view, readHistory],
    deny: [send],
  };
  const worldReadOnly = {
    id: input.worldRoleId,
    allow: [view, readHistory],
    deny: [send],
  };
  const worldWritable = {
    id: input.worldRoleId,
    allow: [view, readHistory, send],
  };

  return {
    info: [everyoneReadOnly, worldReadOnly, ...allowBot],
    roleplay: [everyoneReadOnly, worldWritable, ...allowBot],
    proposals: [everyoneReadOnly, worldWritable, ...allowBot],
    voice: [
      { id: input.everyoneRoleId, allow: [view], deny: [connect] },
      { id: input.worldRoleId, allow: [view, connect, speak] },
    ],
  };
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
    `3) 当用户请求修改世界设定/正典时：不要直接改写文件；应引导走 /submit 或鼓励世界创作者用 /chronicle add。`,
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
