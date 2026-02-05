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
  type APIEmbed,
  type Attachment,
  type ChatInputCommandInteraction,
  type Guild,
  type GuildMember,
  type PartialGuildMember,
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
import {
  buildDiscordOnboardingIdentityRoleConfig,
  resolveDiscordIdentityRoles,
} from "./onboarding-identity";
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
import {
  DEFAULT_DISCORD_TEXT_ATTACHMENT_MAX_BYTES,
  fetchDiscordTextAttachment,
} from "./text-attachments";
import {
  buildMarkdownCardEmbeds,
  chunkEmbedsForDiscord,
} from "./markdown-cards";
import path from "node:path";
import { writeFile, mkdir, rename, rm } from "node:fs/promises";
import { createTraceId } from "../../telemetry";
import { redactSensitiveText } from "../../utils/redact";
import { extractTextFromJsonDocument } from "../../utils/json-text";
import { isSafePathSegment } from "../../utils/path";
import {
  UserStateStore,
  type UserLanguage,
  type UserRole,
} from "../../user/state-store";
import {
  buildCharacterBuildAgentPrompt,
  buildDefaultCharacterCard,
  buildDiscordCharacterBuildKickoff,
  buildDiscordCharacterCreateGuide,
  buildDiscordCharacterHelp,
  buildDiscordHelp,
  buildDiscordOnboardingAutoPrompt,
  buildDiscordOnboardingGuide,
  buildDiscordWorldBuildKickoff,
  buildDiscordWorldCharacterBuildKickoff,
  buildDiscordWorldCreateGuide,
  buildDiscordWorldHelp,
  buildWorldAgentPrompt,
  buildWorldBuildAgentPrompt,
  buildWorldCharacterBuildAgentPrompt,
  buildCharacterSourceSeedContent,
  buildWorldSourceSeedContent,
  buildWorldSubmissionMarkdown,
} from "../../texts";

function pickByLanguage(
  language: UserLanguage | null | undefined,
  zh: string,
  en: string,
): string {
  return language === "en" ? en : zh;
}

class LocalizedError extends Error {
  readonly zh: string;
  readonly en: string;

  constructor(input: { zh: string; en: string }) {
    super(input.zh);
    this.zh = input.zh;
    this.en = input.en;
    this.name = "LocalizedError";
  }
}

function resolveUserMessageFromError(
  language: UserLanguage | null | undefined,
  err: unknown,
  fallback: { zh: string; en: string },
): string {
  if (err instanceof LocalizedError) {
    return language === "en" ? err.en : err.zh;
  }
  return language === "en" ? fallback.en : fallback.zh;
}

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
  private pendingInteractionReplies: Map<
    string,
    { interaction: ChatInputCommandInteraction; createdAtMs: number }
  > = new Map();
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
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
      ],
      partials: [Partials.Channel, Partials.GuildMember, Partials.User],
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

    this.client.on("guildMemberUpdate", (oldMember, newMember) => {
      void this.handleGuildMemberUpdate(oldMember, newMember).catch((err) => {
        this.logger.warn({ err }, "Failed to handle guild member update");
      });
    });

    this.client.on("guildMemberAdd", (member) => {
      void this.maybeAutoStartOnboardingFromIdentityGroup(member).catch(
        (err) => {
          this.logger.warn({ err }, "Failed to handle guild member add");
        },
      );
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
      void this.handleInteraction(interaction).catch(async (err) => {
        this.logger.error({ err }, "Failed to handle Discord interaction");
        if (!interaction.isChatInputCommand()) {
          return;
        }
        const language = await this.userState
          .getLanguage(interaction.user.id)
          .catch(() => null);
        await safeReply(
          interaction,
          resolveUserMessageFromError(language, err, {
            zh: "处理失败，请稍后重试。",
            en: "Failed. Please try again.",
          }),
          { ephemeral: true },
        );
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
    const interaction = this.takePendingInteractionReply(session);
    if (interaction) {
      const updated = await tryEditInteractionReply(interaction, content, {
        ephemeral: true,
      });
      if (updated) {
        return;
      }
    }
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
      try {
        const handled = await this.maybeUpdateWorldShowcaseCover(message);
        if (handled) {
          return;
        }
      } catch (err) {
        this.logger.warn(
          { err },
          "Failed to handle world showcase cover update",
        );
      }

      const parsed = parseMessage(message, this.botUserId ?? undefined);
      if (!parsed) {
        return;
      }
      const augmented = await this.maybeAugmentOnboardingMention(parsed);
      try {
        await this.maybeSeedUserLanguageFromText(
          augmented.userId,
          augmented.content,
        );
      } catch (err) {
        this.logger.warn({ err }, "Failed to infer user language from message");
      }
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

      let parsedWorldGroup: ReturnType<typeof parseWorldGroup> | null = null;
      let parsedCharacterGroup: ReturnType<typeof parseCharacterGroup> | null =
        null;
      if (
        (augmented.content && augmented.content.trim()) ||
        (message.attachments && message.attachments.size)
      ) {
        const groupId = await this.worldStore
          .getGroupIdByChannel(message.channelId)
          .catch(() => null);
        if (groupId) {
          parsedWorldGroup = parseWorldGroup(groupId);
          parsedCharacterGroup = parseCharacterGroup(groupId);
        }
      }

      try {
        await this.ingestWorldBuildMessageContent(
          message,
          augmented,
          parsedWorldGroup,
        );
      } catch (err) {
        this.logger.warn({ err }, "Failed to ingest world build text");
      }
      try {
        await this.ingestCharacterBuildMessageContent(
          message,
          augmented,
          parsedCharacterGroup,
        );
      } catch (err) {
        this.logger.warn({ err }, "Failed to ingest character build text");
      }
      let shouldEmitEvent = true;
      try {
        shouldEmitEvent = await this.ingestWorldBuildAttachments(
          message,
          augmented,
          parsedWorldGroup,
        );
      } catch (err) {
        this.logger.warn({ err }, "Failed to ingest world build attachments");
      }
      try {
        shouldEmitEvent =
          shouldEmitEvent &&
          (await this.ingestCharacterBuildAttachments(
            message,
            augmented,
            parsedCharacterGroup,
          ));
      } catch (err) {
        this.logger.warn(
          { err },
          "Failed to ingest character build attachments",
        );
      }
      if (!shouldEmitEvent) {
        return;
      }
      try {
        const blocked = await this.maybeRejectWorldPlayMessageNotMember(
          message,
          augmented,
        );
        if (blocked) {
          return;
        }
      } catch (err) {
        this.logger.warn({ err }, "Failed to check world membership");
      }
      this.logger.debug({ messageId: parsed.messageId }, "Message received");
      await this.emitEvent(augmented);
    } catch (err) {
      this.logger.error({ err }, "Failed to handle Discord message");
    }
  }

  private async handleGuildMemberUpdate(
    oldMember: GuildMember | PartialGuildMember,
    newMember: GuildMember | PartialGuildMember,
  ): Promise<void> {
    void oldMember;
    await this.maybeAutoStartOnboardingFromIdentityGroup(newMember);
  }

  private async maybeAutoStartOnboardingFromIdentityGroup(
    member: GuildMember | PartialGuildMember,
  ): Promise<void> {
    const config = getConfig();
    if (!config.DISCORD_ONBOARDING_AUTO_START) {
      return;
    }
    if (member.user?.bot) {
      return;
    }
    const botUserId = this.botUserId ?? this.client.user?.id ?? "";
    if (!botUserId) {
      return;
    }

    const existing = await this.userState.read(member.id);
    const threadIds = existing?.onboardingThreadIds ?? null;
    const language = existing?.language ?? null;

    const roleSnapshot = member.partial
      ? await member.fetch().catch(() => member)
      : member;
    const roles = roleSnapshot.roles?.cache?.values
      ? Array.from(roleSnapshot.roles.cache.values())
      : [];
    const roleNames = roles.map((role) => role.name);
    const roleIds = roles.map((role) => role.id);
    const roleConfig = buildDiscordOnboardingIdentityRoleConfig({
      creatorRoleIdsRaw: config.DISCORD_ONBOARDING_IDENTITY_ROLE_IDS_CREATOR,
      playerRoleIdsRaw: config.DISCORD_ONBOARDING_IDENTITY_ROLE_IDS_PLAYER,
      creatorRoleNamesRaw:
        config.DISCORD_ONBOARDING_IDENTITY_ROLE_NAMES_CREATOR,
      playerRoleNamesRaw: config.DISCORD_ONBOARDING_IDENTITY_ROLE_NAMES_PLAYER,
    });
    const inferred = resolveDiscordIdentityRoles({
      memberRoleIds: roleIds,
      memberRoleNames: roleNames,
      config: roleConfig,
    });
    const desiredRoles: UserRole[] = [];
    if (inferred.admin) {
      desiredRoles.push("admin");
    }
    if (inferred.worldCreater) {
      desiredRoles.push("world creater");
    }
    if (inferred.adventurer) {
      desiredRoles.push("adventurer");
    }
    if (desiredRoles.length === 0) {
      return;
    }

    const existingThreadIds = threadIds ?? {};
    const needRoles = desiredRoles.filter(
      (role) => !existingThreadIds[role]?.trim(),
    );
    if (needRoles.length === 0) {
      return;
    }

    await this.userState.addRoles(member.id, desiredRoles).catch(() => {
      // ignore
    });

    const created: Array<{ role: UserRole; channelId: string }> = [];
    for (const role of needRoles) {
      const threadId = await this.ensureOnboardingThread({
        guild: member.guild,
        userId: member.id,
        role,
        language,
        reason: "onboarding auto start (identity role)",
      });
      await this.sendLongTextToChannel({
        guildId: member.guild.id,
        channelId: threadId,
        content: buildDiscordOnboardingGuide({ role, language }),
      });
      created.push({ role, channelId: threadId });
    }

    if (created.length === 0) {
      return;
    }

    const roleLabel =
      language === "en"
        ? (role: UserRole) => role
        : (role: UserRole) =>
            role === "admin"
              ? "管理员"
              : role === "world creater"
                ? "世界创建者"
                : "冒险者";
    const dm =
      language === "en"
        ? [
            "I've auto-started your onboarding guide based on your selected identity role(s):",
            ...created.map(
              (entry) => `- ${roleLabel(entry.role)}: <#${entry.channelId}>`,
            ),
            "",
            "Tip: you can always run /onboard to recover the entry link.",
          ].join("\n")
        : [
            "我已根据你选择的身份组，自动为你开启新手引导：",
            ...created.map(
              (entry) => `- ${roleLabel(entry.role)}：<#${entry.channelId}>`,
            ),
            "",
            "提示：丢了入口可以随时 /onboard 找回。",
          ].join("\n");
    await member.send(dm).catch(() => null);
  }

  private async maybeUpdateWorldShowcaseCover(
    message: Message,
  ): Promise<boolean> {
    if (!message.guildId || !message.guild) {
      return false;
    }
    if (message.author?.bot) {
      return false;
    }

    const threadId = message.channelId?.trim() ?? "";
    if (!threadId) {
      return false;
    }
    const worldId =
      await this.worldStore.getWorldIdByShowcaseThreadId(threadId);
    if (!worldId) {
      return false;
    }
    const meta = await this.worldStore.getWorld(worldId);
    if (!meta) {
      return false;
    }
    if (meta.creatorId !== message.author.id) {
      return false;
    }

    const content = message.content?.trim() ?? "";
    if (!isWorldShowcaseCoverIntent(content)) {
      return false;
    }

    const image = pickFirstImageAttachment(message);
    if (!image) {
      await message.reply(
        "缺少图片：请附带一张图片，并在消息里包含 `#cover`（或“封面”）。",
      );
      return true;
    }

    const showcase = await this.worldStore.getWorldShowcasePost(worldId);
    if (!showcase) {
      return false;
    }
    if (showcase.threadId !== threadId) {
      return false;
    }

    const channel = await this.client.channels
      .fetch(threadId)
      .catch(() => null);
    if (!channel || typeof channel !== "object") {
      return false;
    }
    const messages = (channel as unknown as { messages?: unknown }).messages;
    const fetcher =
      messages && typeof messages === "object"
        ? (messages as { fetch?: unknown }).fetch
        : null;
    if (typeof fetcher !== "function") {
      return false;
    }

    const target = await (
      messages as { fetch: (id: string) => Promise<unknown> }
    )
      .fetch(showcase.messageId)
      .catch(() => null);
    if (!target || typeof target !== "object") {
      return false;
    }
    const editor = (target as { edit?: unknown }).edit;
    if (typeof editor !== "function") {
      return false;
    }

    const embedsRaw =
      "embeds" in target &&
      Array.isArray((target as { embeds?: unknown }).embeds)
        ? ((target as unknown as { embeds: Array<{ toJSON?: () => APIEmbed }> })
            .embeds ?? [])
        : [];

    const language = await this.userState
      .getLanguage(meta.creatorId)
      .catch(() => null);
    const [card, rules] = await Promise.all([
      this.worldFiles.readWorldCard(worldId),
      this.worldFiles.readRules(worldId),
    ]);
    const fallbackEmbeds = buildWorldShowcasePost({
      worldId: meta.id,
      worldName: meta.name,
      creatorId: meta.creatorId,
      language,
      card,
      rules,
    }).embeds;

    const embeds: APIEmbed[] =
      embedsRaw.length > 0
        ? embedsRaw.map((embed) =>
            typeof embed.toJSON === "function"
              ? embed.toJSON()
              : (embed as unknown as APIEmbed),
          )
        : fallbackEmbeds;

    const first = embeds[0] ?? {};
    embeds[0] = { ...first, image: { url: image.url } };

    await (
      target as unknown as {
        edit: (payload: { embeds: APIEmbed[] }) => Promise<unknown>;
      }
    ).edit({ embeds });
    await message.reply("已设置封面。");
    return true;
  }

  private async maybeAugmentOnboardingMention(
    session: SessionEvent<DiscordMessageExtras>,
  ): Promise<SessionEvent<DiscordMessageExtras>> {
    const botId = session.selfId?.trim() ?? "";
    if (!botId) {
      return session;
    }
    const channelId = session.channelId?.trim() ?? "";
    if (!channelId) {
      return session;
    }
    if (
      session.elements.some(
        (element) => element.type === "mention" && element.userId === botId,
      )
    ) {
      return session;
    }

    const state = await this.userState.read(session.userId);
    const threadIds = state?.onboardingThreadIds ?? null;
    if (!threadIds || typeof threadIds !== "object") {
      return session;
    }

    const ids = Object.values(threadIds)
      .map((value) => (typeof value === "string" ? value.trim() : ""))
      .filter(Boolean);
    if (!ids.includes(channelId)) {
      return session;
    }

    return {
      ...session,
      elements: [{ type: "mention", userId: botId }, ...session.elements],
    };
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
          const language = await this.userState
            .getLanguage(meta.creatorId)
            .catch(() => null);
          await this.worldStore.setChannelWorldId(channelId, meta.id);
          await this.worldStore.setChannelGroupId(
            channelId,
            buildWorldBuildGroupId(meta.id),
          );
          await this.ensureWorldBuildGroupAgent({
            worldId: meta.id,
            worldName: meta.name,
            language,
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
          const language = await this.userState
            .getLanguage(meta.creatorId)
            .catch(() => null);
          await this.worldStore.setChannelWorldId(channelId, meta.id);
          await this.worldStore.setChannelGroupId(
            channelId,
            buildWorldBuildGroupId(meta.id),
          );
          await this.ensureWorldBuildGroupAgent({
            worldId: meta.id,
            worldName: meta.name,
            language,
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
      const language = await this.userState
        .getLanguage(meta.creatorId)
        .catch(() => null);
      await this.worldStore.setChannelGroupId(
        channelId,
        buildWorldBuildGroupId(meta.id),
      );
      await this.ensureWorldBuildGroupAgent({
        worldId: meta.id,
        worldName: meta.name,
        language,
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
    if (!message.guildId) {
      return;
    }
    if (!message.guild) {
      return;
    }
    if (!message.author?.id) {
      return;
    }

    const existing = await this.userState.read(message.author.id);
    const hasAnyThread = Boolean(
      existing?.onboardingThreadIds &&
      Object.values(existing.onboardingThreadIds).some(
        (value) => typeof value === "string" && value.trim(),
      ),
    );
    const hasAnyRole = Boolean(existing?.roles && existing.roles.length > 0);
    if (hasAnyRole || hasAnyThread) {
      return;
    }

    const threadId = await this.ensureOnboardingThread({
      guild: message.guild,
      userId: message.author.id,
      role: "adventurer",
      language: existing?.language ?? null,
      reason: "onboarding auto prompt",
    });
    await this.sendLongTextToChannel({
      guildId: message.guildId,
      channelId: threadId,
      content: buildDiscordOnboardingAutoPrompt(existing?.language),
    });
  }

  private async ingestWorldBuildAttachments(
    message: Message,
    session: SessionEvent<DiscordMessageExtras>,
    parsedWorldGroup?: ReturnType<typeof parseWorldGroup> | null,
  ): Promise<boolean> {
    if (!message.attachments || message.attachments.size === 0) {
      return true;
    }

    const parsed =
      parsedWorldGroup ??
      (await this.worldStore
        .getGroupIdByChannel(message.channelId)
        .then((groupId) => (groupId ? parseWorldGroup(groupId) : null))
        .catch(() => null));
    if (!parsed || parsed.kind !== "build") {
      return true;
    }

    const uploaded: Array<{
      filename: string;
      content: string;
      extractedFromJson: boolean;
    }> = [];
    const rejectedTooLarge: string[] = [];
    const rejectedUnsupported: string[] = [];
    const rejectedOther: string[] = [];
    const rejectedEmpty: string[] = [];

    for (const attachment of message.attachments.values()) {
      try {
        const doc = await fetchDiscordTextAttachment(attachment, {
          logger: this.logger,
          maxBytes: DEFAULT_DISCORD_TEXT_ATTACHMENT_MAX_BYTES,
        });
        const extracted = extractTextFromJsonDocument(doc.content);
        uploaded.push({
          filename: doc.filename,
          content: extracted?.extracted ?? doc.content,
          extractedFromJson: Boolean(extracted),
        });
      } catch (err) {
        const filename = (attachment.name ?? "").trim() || "document";
        const reason = err instanceof Error ? err.message : String(err);
        if (reason.includes("attachment too large")) {
          rejectedTooLarge.push(filename);
        } else if (reason.includes("unsupported attachment type")) {
          rejectedUnsupported.push(filename);
        } else if (reason.includes("attachment is empty")) {
          rejectedEmpty.push(filename);
        } else {
          rejectedOther.push(filename);
        }
      }
    }

    if (uploaded.length === 0) {
      const rejected = [
        ...rejectedTooLarge,
        ...rejectedUnsupported,
        ...rejectedEmpty,
        ...rejectedOther,
      ];
      if (rejected.length === 0) {
        return true;
      }

      const limitMb = Math.floor(
        DEFAULT_DISCORD_TEXT_ATTACHMENT_MAX_BYTES / (1024 * 1024),
      );
      const supported = `支持：txt/md/json（以及可解析的 docx）`;
      const lines: string[] = [];
      if (rejectedTooLarge.length > 0) {
        lines.push(
          `设定文档过大（单个文件最大 ${limitMb}MB）：${rejectedTooLarge.join(", ")}`,
        );
      }
      if (rejectedUnsupported.length > 0) {
        lines.push(`设定文档类型不支持：${rejectedUnsupported.join(", ")}`);
      }
      if (rejectedEmpty.length > 0) {
        lines.push(`设定文档内容为空：${rejectedEmpty.join(", ")}`);
      }
      if (rejectedOther.length > 0) {
        lines.push(`设定文档暂未读取：${rejectedOther.join(", ")}`);
      }
      lines.push(supported);

      await this.sendMessage(session, lines.join("\n"));

      const hasUserText = Boolean(session.content && session.content.trim());
      return hasUserText;
    }

    const nowIso = new Date().toISOString();
    const merged =
      uploaded.length === 1
        ? [
            `# 上传文档：${uploaded[0].filename}`,
            `- 时间：${nowIso}`,
            uploaded[0].extractedFromJson ? `- 解析：已从 JSON 提取正文` : null,
            ``,
            uploaded[0].content.trimEnd(),
          ].join("\n")
        : uploaded
            .map((doc) =>
              [
                `# 上传文档：${doc.filename}`,
                `- 时间：${nowIso}`,
                doc.extractedFromJson ? `- 解析：已从 JSON 提取正文` : null,
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

    await this.worldFiles.appendSourceDocument(parsed.worldId, {
      filename,
      content: `${merged.trimEnd()}\n\n`,
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
    const ignoredLines: string[] = [];
    if (rejectedTooLarge.length > 0) {
      const limitMb = Math.floor(
        DEFAULT_DISCORD_TEXT_ATTACHMENT_MAX_BYTES / (1024 * 1024),
      );
      ignoredLines.push(
        `文件过大（单个最大 ${limitMb}MB）：${rejectedTooLarge.join(", ")}`,
      );
    }
    if (rejectedUnsupported.length > 0) {
      ignoredLines.push(`类型不支持：${rejectedUnsupported.join(", ")}`);
    }
    if (rejectedEmpty.length > 0) {
      ignoredLines.push(`内容为空：${rejectedEmpty.join(", ")}`);
    }
    if (rejectedOther.length > 0) {
      ignoredLines.push(`未读取：${rejectedOther.join(", ")}`);
    }

    if (ignoredLines.length > 0) {
      await this.sendMessage(
        session,
        `已读取并写入 world/source.md（${uploaded.length} 个文档）。以下文件被忽略：\n${ignoredLines.map((line) => `- ${line}`).join("\n")}`,
      );
    }

    return true;
  }

  private async ingestWorldBuildMessageContent(
    message: Message,
    session: SessionEvent<DiscordMessageExtras>,
    parsedWorldGroup?: ReturnType<typeof parseWorldGroup> | null,
  ): Promise<void> {
    const rawContent = session.content ?? "";
    if (!rawContent.trim()) {
      return;
    }

    const parsed =
      parsedWorldGroup ??
      (await this.worldStore
        .getGroupIdByChannel(message.channelId)
        .then((groupId) => (groupId ? parseWorldGroup(groupId) : null))
        .catch(() => null));
    if (!parsed || parsed.kind !== "build") {
      return;
    }

    const ts = Number.isFinite(message.createdTimestamp)
      ? message.createdTimestamp
      : Date.now();
    const nowIso = new Date(ts).toISOString();
    const authorLabel = session.extras.authorName?.trim()
      ? `${session.extras.authorName} (${session.userId})`
      : session.userId;

    const extracted = extractTextFromJsonDocument(rawContent);
    const normalizedContent = extracted?.extracted ?? rawContent;
    const sectionTitle = extracted ? "## 用户文本（JSON 提取）" : "## 用户文本";

    await this.worldFiles.appendSourceDocument(parsed.worldId, {
      content: [
        sectionTitle,
        `- 时间：${nowIso}`,
        `- 用户：${authorLabel}`,
        ``,
        normalizedContent.trimEnd(),
        ``,
        ``,
      ].join("\n"),
    });
  }

  private async ingestCharacterBuildAttachments(
    message: Message,
    session: SessionEvent<DiscordMessageExtras>,
    parsedCharacterGroup?: ReturnType<typeof parseCharacterGroup> | null,
  ): Promise<boolean> {
    if (!message.attachments || message.attachments.size === 0) {
      return true;
    }

    const parsed =
      parsedCharacterGroup ??
      (await this.worldStore
        .getGroupIdByChannel(message.channelId)
        .then((groupId) => (groupId ? parseCharacterGroup(groupId) : null))
        .catch(() => null));
    if (!parsed) {
      return true;
    }

    const characterId = parsed.characterId;
    if (!Number.isInteger(characterId) || characterId <= 0) {
      return true;
    }

    const uploaded: Array<{
      filename: string;
      content: string;
      extractedFromJson: boolean;
    }> = [];
    const rejectedTooLarge: string[] = [];
    const rejectedUnsupported: string[] = [];
    const rejectedOther: string[] = [];
    const rejectedEmpty: string[] = [];

    for (const attachment of message.attachments.values()) {
      try {
        const doc = await fetchDiscordTextAttachment(attachment, {
          logger: this.logger,
          maxBytes: DEFAULT_DISCORD_TEXT_ATTACHMENT_MAX_BYTES,
        });
        const extracted = extractTextFromJsonDocument(doc.content);
        uploaded.push({
          filename: doc.filename,
          content: extracted?.extracted ?? doc.content,
          extractedFromJson: Boolean(extracted),
        });
      } catch (err) {
        const filename = (attachment.name ?? "").trim() || "document";
        const reason = err instanceof Error ? err.message : String(err);
        if (reason.includes("attachment too large")) {
          rejectedTooLarge.push(filename);
        } else if (reason.includes("unsupported attachment type")) {
          rejectedUnsupported.push(filename);
        } else if (reason.includes("attachment is empty")) {
          rejectedEmpty.push(filename);
        } else {
          rejectedOther.push(filename);
        }
      }
    }

    if (uploaded.length === 0) {
      const rejected = [
        ...rejectedTooLarge,
        ...rejectedUnsupported,
        ...rejectedEmpty,
        ...rejectedOther,
      ];
      if (rejected.length === 0) {
        return true;
      }

      const limitMb = Math.floor(
        DEFAULT_DISCORD_TEXT_ATTACHMENT_MAX_BYTES / (1024 * 1024),
      );
      const supported = `支持：txt/md/json（以及可解析的 docx）`;
      const lines: string[] = [];
      if (rejectedTooLarge.length > 0) {
        lines.push(
          `设定文档过大（单个文件最大 ${limitMb}MB）：${rejectedTooLarge.join(", ")}`,
        );
      }
      if (rejectedUnsupported.length > 0) {
        lines.push(`设定文档类型不支持：${rejectedUnsupported.join(", ")}`);
      }
      if (rejectedEmpty.length > 0) {
        lines.push(`设定文档内容为空：${rejectedEmpty.join(", ")}`);
      }
      if (rejectedOther.length > 0) {
        lines.push(`设定文档暂未读取：${rejectedOther.join(", ")}`);
      }
      lines.push(supported);

      await this.sendMessage(session, lines.join("\n"));

      const hasUserText = Boolean(session.content && session.content.trim());
      return hasUserText;
    }

    const nowIso = new Date().toISOString();
    const merged =
      uploaded.length === 1
        ? [
            `# 上传文档：${uploaded[0].filename}`,
            `- 时间：${nowIso}`,
            uploaded[0].extractedFromJson ? `- 解析：已从 JSON 提取正文` : null,
            ``,
            uploaded[0].content.trimEnd(),
          ].join("\n")
        : uploaded
            .map((doc) =>
              [
                `# 上传文档：${doc.filename}`,
                `- 时间：${nowIso}`,
                doc.extractedFromJson ? `- 解析：已从 JSON 提取正文` : null,
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

    await this.worldFiles.appendCharacterSourceDocument(characterId, {
      filename,
      content: `${merged.trimEnd()}\n\n`,
    });
    for (const doc of uploaded) {
      await this.worldFiles.appendCharacterEvent(characterId, {
        type: "character_source_uploaded",
        characterId,
        guildId: message.guildId,
        userId: message.author.id,
        filename: doc.filename,
        messageId: message.id,
      });
    }

    const ignoredLines: string[] = [];
    if (rejectedTooLarge.length > 0) {
      const limitMb = Math.floor(
        DEFAULT_DISCORD_TEXT_ATTACHMENT_MAX_BYTES / (1024 * 1024),
      );
      ignoredLines.push(
        `文件过大（单个最大 ${limitMb}MB）：${rejectedTooLarge.join(", ")}`,
      );
    }
    if (rejectedUnsupported.length > 0) {
      ignoredLines.push(`类型不支持：${rejectedUnsupported.join(", ")}`);
    }
    if (rejectedEmpty.length > 0) {
      ignoredLines.push(`内容为空：${rejectedEmpty.join(", ")}`);
    }
    if (rejectedOther.length > 0) {
      ignoredLines.push(`未读取：${rejectedOther.join(", ")}`);
    }

    if (ignoredLines.length > 0) {
      await this.sendMessage(
        session,
        `已读取并写入 character/source.md（${uploaded.length} 个文档）。以下文件被忽略：\n${ignoredLines.map((line) => `- ${line}`).join("\n")}`,
      );
    } else if (!session.content?.trim()) {
      await this.sendMessage(
        session,
        `已读取并写入 character/source.md（${uploaded.length} 个文档）。`,
      );
    }

    return true;
  }

  private async ingestCharacterBuildMessageContent(
    message: Message,
    session: SessionEvent<DiscordMessageExtras>,
    parsedCharacterGroup?: ReturnType<typeof parseCharacterGroup> | null,
  ): Promise<void> {
    const rawContent = session.content ?? "";
    if (!rawContent.trim()) {
      return;
    }

    const parsed =
      parsedCharacterGroup ??
      (await this.worldStore
        .getGroupIdByChannel(message.channelId)
        .then((groupId) => (groupId ? parseCharacterGroup(groupId) : null))
        .catch(() => null));
    if (!parsed) {
      return;
    }

    const characterId = parsed.characterId;
    if (!Number.isInteger(characterId) || characterId <= 0) {
      return;
    }

    const ts = Number.isFinite(message.createdTimestamp)
      ? message.createdTimestamp
      : Date.now();
    const nowIso = new Date(ts).toISOString();
    const authorLabel = session.extras.authorName?.trim()
      ? `${session.extras.authorName} (${session.userId})`
      : session.userId;

    const extracted = extractTextFromJsonDocument(rawContent);
    const normalizedContent = extracted?.extracted ?? rawContent;
    const sectionTitle = extracted ? "## 用户文本（JSON 提取）" : "## 用户文本";

    await this.worldFiles.appendCharacterSourceDocument(characterId, {
      content: [
        sectionTitle,
        `- 时间：${nowIso}`,
        `- 用户：${authorLabel}`,
        ``,
        normalizedContent.trimEnd(),
        ``,
        ``,
      ].join("\n"),
    });
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

  private async maybeSeedUserLanguage(
    interaction: ChatInputCommandInteraction,
  ): Promise<void> {
    const existing = await this.userState
      .getLanguage(interaction.user.id)
      .catch(() => null);
    if (existing) {
      return;
    }
    const inferred = resolveUserLanguageFromDiscordLocale(interaction.locale);
    if (!inferred) {
      return;
    }
    await this.userState
      .setLanguage(interaction.user.id, inferred)
      .catch(() => {
        // ignore
      });
  }

  private async maybeSeedUserLanguageFromText(
    userId: string,
    text: string,
  ): Promise<void> {
    const existing = await this.userState.getLanguage(userId).catch(() => null);
    if (existing) {
      return;
    }
    const inferred = inferUserLanguageFromText(text);
    if (!inferred) {
      return;
    }
    await this.userState.setLanguage(userId, inferred).catch(() => {
      // ignore
    });
  }

  private async handleInteraction(interaction: Interaction): Promise<void> {
    if (!interaction.isChatInputCommand()) {
      return;
    }

    await this.maybeSeedUserLanguage(interaction);

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
      const language = await this.userState
        .getLanguage(interaction.user.id)
        .catch(() => null);
      await safeReply(interaction, buildDiscordHelp(language), {
        ephemeral: true,
      });
      return;
    }
    if (commandName === "onboard") {
      await this.handleOnboard(interaction);
      return;
    }
    if (commandName === "language") {
      await this.handleLanguage(interaction);
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
      this.rememberPendingInteractionReply(interaction);

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
      this.rememberPendingInteractionReply(interaction);

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
      this.rememberPendingInteractionReply(interaction);

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
    await safeDefer(interaction, { ephemeral: true });
    const roleRaw = interaction.options.getString("role", true).trim();
    const roles: UserRole[] =
      roleRaw === "both"
        ? ["adventurer", "world creater"]
        : roleRaw === "admin"
          ? ["admin"]
          : roleRaw === "adventurer"
            ? ["adventurer"]
            : roleRaw === "world creater"
              ? ["world creater"]
              : ["adventurer"];
    const uniqueRoles = Array.from(new Set(roles));
    await this.userState.addRoles(interaction.user.id, uniqueRoles);
    const language = await this.userState
      .getLanguage(interaction.user.id)
      .catch(() => null);

    if (!interaction.guildId || !interaction.guild) {
      await safeReply(
        interaction,
        pickByLanguage(
          language,
          "该指令仅支持在服务器内使用。",
          "This command can only be used in a server.",
        ),
        { ephemeral: true },
      );
      return;
    }

    const created: Array<{ role: UserRole; channelId: string }> = [];
    for (const role of uniqueRoles) {
      const threadId = await this.ensureOnboardingThread({
        guild: interaction.guild,
        userId: interaction.user.id,
        role,
        language,
        reason: `onboard role=${roleRaw}`,
      });
      await this.sendLongTextToChannel({
        guildId: interaction.guildId,
        channelId: threadId,
        content: buildDiscordOnboardingGuide({ role, language }),
      });
      created.push({ role, channelId: threadId });
    }

    const roleLabel =
      language === "en"
        ? (role: UserRole) => role
        : (role: UserRole) =>
            role === "admin"
              ? "管理员"
              : role === "world creater"
                ? "世界创建者"
                : "冒险者";
    await safeReply(
      interaction,
      language === "en"
        ? [
            `Role(s) set.`,
            ...created.map(
              (entry) => `- ${roleLabel(entry.role)}: <#${entry.channelId}>`,
            ),
            "",
            "(If you lose it, run /onboard again.)",
          ].join("\n")
        : [
            "已选择身份。",
            ...created.map(
              (entry) => `- ${roleLabel(entry.role)}：<#${entry.channelId}>`,
            ),
            "",
            "（丢了入口就再跑一次 /onboard。）",
          ].join("\n"),
      { ephemeral: true },
    );
  }

  private rememberPendingInteractionReply(
    interaction: ChatInputCommandInteraction,
  ): void {
    const now = Date.now();
    this.pendingInteractionReplies.set(interaction.id, {
      interaction,
      createdAtMs: now,
    });
    if (this.pendingInteractionReplies.size <= 200) {
      return;
    }
    for (const [interactionId, entry] of this.pendingInteractionReplies) {
      if (now - entry.createdAtMs > 15 * 60 * 1000) {
        this.pendingInteractionReplies.delete(interactionId);
      }
    }
  }

  private takePendingInteractionReply(
    session: SessionEvent,
  ): ChatInputCommandInteraction | null {
    if (session.platform !== "discord") {
      return null;
    }
    if (!session.extras || typeof session.extras !== "object") {
      return null;
    }
    const extras = session.extras as Record<string, unknown>;
    if (extras["synthetic"] === true) {
      return null;
    }
    const commandName =
      typeof extras["commandName"] === "string" ? extras["commandName"] : "";
    if (
      commandName !== "reset" &&
      commandName !== "resetall" &&
      commandName !== "model"
    ) {
      return null;
    }
    const interactionId =
      typeof extras["interactionId"] === "string"
        ? extras["interactionId"]
        : "";
    if (!interactionId.trim()) {
      return null;
    }

    const entry = this.pendingInteractionReplies.get(interactionId);
    if (!entry) {
      return null;
    }
    this.pendingInteractionReplies.delete(interactionId);
    if (Date.now() - entry.createdAtMs > 15 * 60 * 1000) {
      return null;
    }
    return entry.interaction;
  }

  private async handleLanguage(
    interaction: ChatInputCommandInteraction,
  ): Promise<void> {
    await safeDefer(interaction, { ephemeral: true });
    const langRaw = interaction.options.getString("lang", true);
    const language = langRaw === "en" ? "en" : "zh";
    await this.userState.setLanguage(interaction.user.id, language);
    await safeReply(
      interaction,
      language === "en"
        ? `Language set: ${language}`
        : `已设置语言：${language}`,
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
    if (subcommand === "publish") {
      await this.handleWorldPublish(interaction);
      return;
    }
    if (subcommand === "export") {
      const worldId = interaction.options.getInteger("world_id") ?? undefined;
      await this.handleWorldExport(interaction, { worldId });
      return;
    }
    if (subcommand === "import") {
      const kind = interaction.options.getString("kind", true);
      const file = interaction.options.getAttachment("file", true);
      const worldId = interaction.options.getInteger("world_id") ?? undefined;
      await this.handleWorldImport(interaction, { kind, file, worldId });
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
    const language = await this.userState
      .getLanguage(interaction.user.id)
      .catch(() => null);
    if (!interaction.guildId || !interaction.guild) {
      await safeReply(
        interaction,
        pickByLanguage(
          language,
          "该指令仅支持在服务器内使用。",
          "This command can only be used in a server.",
        ),
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
    await safeDefer(interaction, { ephemeral: true });

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
        pickByLanguage(
          language,
          `无权限：当前 createPolicy=${policy}（默认 admin）。`,
          `Permission denied: createPolicy=${policy} (default: admin).`,
        ),
        { ephemeral: true },
      );
      return;
    }

    const guild = interaction.guild;

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
        content: buildWorldSourceSeedContent(language),
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
        language,
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
        language,
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
        name: pickByLanguage(
          language,
          `世界创建 W${worldId}`,
          `World Create W${worldId}`,
        ),
        reason: `world create W${worldId} by ${interaction.user.id}`,
        memberUserId: interaction.user.id,
      });
      if (!thread) {
        throw new Error(
          pickByLanguage(
            language,
            "无法创建世界编辑话题：请检查 bot 是否具备创建话题权限（CreatePrivateThreads）",
            "Failed to create the world editing thread: please check the bot permission (CreatePrivateThreads).",
          ),
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
        language,
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
        pickByLanguage(
          language,
          [
            `世界创建已开始：W${worldId}`,
            `继续创建：${buildConversationMention}`,
          ].join("\n"),
          [
            `World creation started: W${worldId}`,
            `Continue here: ${buildConversationMention}`,
          ].join("\n"),
        ),
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
        pickByLanguage(
          language,
          `创建失败：${err instanceof Error ? err.message : String(err)}`,
          `Failed: ${err instanceof Error ? err.message : String(err)}`,
        ),
        { ephemeral: true },
      );
    }
  }

  private async handleWorldHelp(
    interaction: ChatInputCommandInteraction,
  ): Promise<void> {
    const language = await this.userState
      .getLanguage(interaction.user.id)
      .catch(() => null);
    await safeReply(interaction, buildDiscordWorldHelp(language), {
      ephemeral: true,
    });
  }

  private async handleWorldExport(
    interaction: ChatInputCommandInteraction,
    input: { worldId?: number },
  ): Promise<void> {
    await safeDefer(interaction, { ephemeral: true });
    const worldId =
      input.worldId ??
      (await this.inferWorldIdFromWorldSubspace(interaction).catch(() => null));
    if (!worldId) {
      await safeReply(
        interaction,
        "缺少 world_id：请在世界子空间/编辑话题内执行，或显式提供 world_id。",
        { ephemeral: true },
      );
      return;
    }

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
        `请在世界入口服务器执行：guild:${meta.homeGuildId}`,
        { ephemeral: true },
      );
      return;
    }
    if (meta.creatorId !== interaction.user.id) {
      await safeReply(interaction, "无权限：只有世界创作者可以导出世界文档。", {
        ephemeral: true,
      });
      return;
    }

    const language = await this.userState
      .getLanguage(interaction.user.id)
      .catch(() => null);
    await this.worldFiles.ensureDefaultFiles({
      worldId: meta.id,
      worldName: meta.name,
      creatorId: meta.creatorId,
      language,
    });

    const [card, rules, chronicle, tasks, news, canon] = await Promise.all([
      this.worldFiles.readWorldCard(meta.id),
      this.worldFiles.readRules(meta.id),
      this.worldFiles.readCanon(meta.id, "chronicle.md"),
      this.worldFiles.readCanon(meta.id, "tasks.md"),
      this.worldFiles.readCanon(meta.id, "news.md"),
      this.worldFiles.readCanon(meta.id, "canon.md"),
    ]);
    if (
      card === null ||
      rules === null ||
      chronicle === null ||
      tasks === null ||
      news === null ||
      canon === null
    ) {
      await safeReply(interaction, "世界文档不完整，暂无法导出。", {
        ephemeral: true,
      });
      return;
    }

    const files: Array<{ attachment: Buffer; name: string }> = [
      {
        attachment: Buffer.from(card, "utf8"),
        name: `W${meta.id}-world-card.md`,
      },
      { attachment: Buffer.from(rules, "utf8"), name: `W${meta.id}-rules.md` },
      {
        attachment: Buffer.from(chronicle, "utf8"),
        name: `W${meta.id}-chronicle.md`,
      },
      { attachment: Buffer.from(tasks, "utf8"), name: `W${meta.id}-tasks.md` },
      { attachment: Buffer.from(news, "utf8"), name: `W${meta.id}-news.md` },
      { attachment: Buffer.from(canon, "utf8"), name: `W${meta.id}-canon.md` },
    ];

    await safeReplyRich(
      interaction,
      {
        content: [
          `已导出世界文档：W${meta.id} ${meta.name}`,
          "改完后把文件作为附件上传，然后用 /world import 覆盖对应文档。",
          "提示：导入 kind=canon 时，会写入 worlds/<id>/canon/<filename>；若文件名带 `W<id>-` 前缀会自动剥离。",
          "支持 .md/.txt（会覆盖原内容）。",
        ].join("\n"),
        files,
      },
      { ephemeral: true },
    );
  }

  private async handleWorldImport(
    interaction: ChatInputCommandInteraction,
    input: { kind: string; file: Attachment; worldId?: number },
  ): Promise<void> {
    await safeDefer(interaction, { ephemeral: true });
    const worldId =
      input.worldId ??
      (await this.inferWorldIdFromWorldSubspace(interaction).catch(() => null));
    if (!worldId) {
      await safeReply(
        interaction,
        "缺少 world_id：请在世界子空间/编辑话题内执行，或显式提供 world_id。",
        { ephemeral: true },
      );
      return;
    }

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
        `请在世界入口服务器执行：guild:${meta.homeGuildId}`,
        { ephemeral: true },
      );
      return;
    }
    if (meta.creatorId !== interaction.user.id) {
      await safeReply(interaction, "无权限：只有世界创作者可以覆盖世界文档。", {
        ephemeral: true,
      });
      return;
    }

    let doc: { filename: string; content: string };
    try {
      doc = await fetchDiscordTextAttachment(input.file, {
        logger: this.logger,
        maxBytes: DEFAULT_DISCORD_TEXT_ATTACHMENT_MAX_BYTES,
      });
    } catch (err) {
      await safeReply(
        interaction,
        `读取附件失败：${err instanceof Error ? err.message : String(err)}`,
        { ephemeral: true },
      );
      return;
    }

    if (!isAllowedWikiImportFilename(doc.filename)) {
      await safeReply(interaction, "仅支持导入 .md/.markdown/.txt 文件。", {
        ephemeral: true,
      });
      return;
    }

    const kind = input.kind.trim();
    let target: string;
    if (kind === "world_card") {
      await this.worldFiles.writeWorldCard(meta.id, doc.content);
      target = "world-card.md";
    } else if (kind === "rules") {
      await this.worldFiles.writeRules(meta.id, doc.content);
      target = "rules.md";
    } else if (kind === "canon") {
      const canonFilename = resolveCanonImportFilename(meta.id, doc.filename);
      if (
        !canonFilename ||
        !isSafePathSegment(canonFilename) ||
        !isAllowedWikiImportFilename(canonFilename) ||
        canonFilename === "world-card.md" ||
        canonFilename === "rules.md"
      ) {
        await safeReply(
          interaction,
          "canon 导入文件名不合法：请使用安全文件名（如 canon.md/chronicle.md/tasks.md/news.md），仅允许 .md/.markdown/.txt。",
          { ephemeral: true },
        );
        return;
      }

      await this.worldFiles.writeCanon(meta.id, canonFilename, doc.content);
      target = `canon/${canonFilename}`;
    } else {
      await safeReply(
        interaction,
        `未知 kind：${kind}（可选：world_card/rules/canon）`,
        { ephemeral: true },
      );
      return;
    }

    await this.worldFiles.appendEvent(meta.id, {
      type: "world_doc_imported",
      worldId: meta.id,
      userId: interaction.user.id,
      kind,
      filename: doc.filename,
    });

    await safeReply(
      interaction,
      `已覆盖 W${meta.id} ${meta.name}：${target}（来源：${doc.filename}）`,
      { ephemeral: true },
    );
  }

  private async handleWorldOpen(
    interaction: ChatInputCommandInteraction,
    worldId: number,
  ): Promise<void> {
    await safeDefer(interaction, { ephemeral: true });
    const language = await this.userState
      .getLanguage(interaction.user.id)
      .catch(() => null);
    const meta = await this.worldStore.getWorld(worldId);
    if (!meta) {
      await safeReply(
        interaction,
        pickByLanguage(
          language,
          `世界不存在：W${worldId}`,
          `World not found: W${worldId}`,
        ),
        { ephemeral: true },
      );
      return;
    }
    if (meta.creatorId !== interaction.user.id) {
      await safeReply(
        interaction,
        pickByLanguage(
          language,
          "无权限：只有世界创作者可以编辑世界。",
          "Permission denied: only the world creator can edit this world.",
        ),
        { ephemeral: true },
      );
      return;
    }

    await this.ensureWorldBuildGroupAgent({
      worldId: meta.id,
      worldName: meta.name,
      language,
    });
    if (!interaction.guildId || !interaction.guild) {
      await safeReply(
        interaction,
        pickByLanguage(
          language,
          "该指令仅支持在服务器内使用。",
          "This command can only be used in a server.",
        ),
        { ephemeral: true },
      );
      return;
    }
    if (interaction.guildId !== meta.homeGuildId) {
      await safeReply(
        interaction,
        pickByLanguage(
          language,
          `请在世界入口服务器执行：guild:${meta.homeGuildId}`,
          `Please run this command in the world's entry server: guild:${meta.homeGuildId}`,
        ),
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
      try {
        await this.reopenPrivateThreadForUser(fetched, interaction.user.id, {
          reason: `world open W${meta.id}`,
        });
      } catch {
        // ignore
      }
      try {
        const currentName =
          fetched && typeof fetched === "object" && "name" in fetched
            ? String((fetched as { name: unknown }).name ?? "")
            : "";
        const isCreateThread =
          currentName.startsWith("世界创建") ||
          currentName.startsWith("World Create");
        const desiredName = pickByLanguage(
          language,
          isCreateThread ? `世界创建 W${meta.id}` : `世界编辑 W${meta.id}`,
          isCreateThread
            ? `World Create W${meta.id}`
            : `World Edit W${meta.id}`,
        );
        const setter =
          fetched && typeof fetched === "object" && "setName" in fetched
            ? (fetched as { setName?: unknown }).setName
            : null;
        if (
          typeof setter === "function" &&
          desiredName.trim() &&
          desiredName !== currentName
        ) {
          await (
            fetched as unknown as {
              setName: (name: string, reason?: string) => Promise<unknown>;
            }
          ).setName(desiredName, `world thread rename W${meta.id}`);
        }
      } catch {
        // ignore
      }
    } else {
      const thread = await this.tryCreatePrivateThread({
        guild: interaction.guild,
        parentChannelId: workshop.id,
        name: pickByLanguage(
          language,
          `世界编辑 W${meta.id}`,
          `World Edit W${meta.id}`,
        ),
        reason: `world open W${meta.id} by ${interaction.user.id}`,
        memberUserId: interaction.user.id,
      });
      if (!thread) {
        throw new Error(
          pickByLanguage(
            language,
            "无法创建世界编辑话题：请检查 bot 是否具备创建话题权限（CreatePrivateThreads）",
            "Failed to create the world editing thread: please check the bot permission (CreatePrivateThreads).",
          ),
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
        language,
      });
    }

    await this.worldStore.setChannelGroupId(
      buildConversationChannelId,
      buildWorldBuildGroupId(meta.id),
    );

    await safeReply(
      interaction,
      pickByLanguage(
        language,
        `已打开世界编辑：W${meta.id} ${meta.name}\n编辑话题：<#${buildConversationChannelId}>`,
        `World editor opened: W${meta.id} ${meta.name}\nThread: <#${buildConversationChannelId}>`,
      ),
      { ephemeral: true },
    );
  }

  private async handleWorldPublish(
    interaction: ChatInputCommandInteraction,
  ): Promise<void> {
    const language = await this.userState
      .getLanguage(interaction.user.id)
      .catch(() => null);
    const groupId = await this.worldStore.getGroupIdByChannel(
      interaction.channelId,
    );
    const parsed = groupId ? parseWorldGroup(groupId) : null;
    if (!parsed || parsed.kind !== "build") {
      await safeReply(
        interaction,
        pickByLanguage(
          language,
          "请先执行 /world create 或 /world open，然后在对应编辑话题执行 /world publish。",
          "Run /world create or /world open first, then run /world publish inside the corresponding editing thread.",
        ),
        { ephemeral: true },
      );
      return;
    }

    const meta = await this.worldStore.getWorld(parsed.worldId);
    if (!meta) {
      await safeReply(
        interaction,
        pickByLanguage(
          language,
          `世界不存在：W${parsed.worldId}`,
          `World not found: W${parsed.worldId}`,
        ),
        { ephemeral: true },
      );
      return;
    }
    if (meta.creatorId !== interaction.user.id) {
      await safeReply(
        interaction,
        pickByLanguage(
          language,
          "无权限：只有世界创作者可以发布世界。",
          "Permission denied: only the world creator can publish this world.",
        ),
        { ephemeral: true },
      );
      return;
    }

    await safeDefer(interaction, { ephemeral: true });

    if (meta.status !== "draft") {
      await safeReply(
        interaction,
        pickByLanguage(
          language,
          `世界已发布：W${meta.id} ${meta.name}（status=${meta.status}）`,
          `World already published: W${meta.id} ${meta.name} (status=${meta.status})`,
        ),
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
        pickByLanguage(
          language,
          `无法获取世界入口服务器：guild:${meta.homeGuildId}`,
          `Failed to fetch the world's entry server: guild:${meta.homeGuildId}`,
        ),
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
      language,
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
      pickByLanguage(
        language,
        [
          `世界已发布：W${meta.id} ${worldName}`,
          `公告：<#${created.infoChannelId}>`,
          `讨论：<#${created.discussionChannelId}>`,
          `提案：<#${created.proposalsChannelId}>`,
          `加入：/world join world_id:${meta.id}`,
        ].join("\n"),
        [
          `World published: W${meta.id} ${worldName}`,
          `Announcements: <#${created.infoChannelId}>`,
          `Discussion: <#${created.discussionChannelId}>`,
          `Proposals: <#${created.proposalsChannelId}>`,
          `Join: /world join world_id:${meta.id}`,
        ].join("\n"),
      ),
      { ephemeral: true },
    );

    void this.publishWorldShowcasePost({
      guild,
      worldId: meta.id,
      worldName,
      creatorId: meta.creatorId,
      language,
    }).catch((err) => {
      this.logger.warn(
        { err, worldId: meta.id, guildId: meta.homeGuildId },
        "Failed to publish world showcase post",
      );
    });
  }

  private async handleWorldList(
    interaction: ChatInputCommandInteraction,
  ): Promise<void> {
    const language = await this.userState
      .getLanguage(interaction.user.id)
      .catch(() => null);
    await safeDefer(interaction, { ephemeral: false });
    const limit = interaction.options.getInteger("limit") ?? 20;
    const ids = await this.worldStore.listWorldIds(limit);
    if (ids.length === 0) {
      await safeReply(
        interaction,
        pickByLanguage(language, "暂无世界。", "No worlds yet."),
        { ephemeral: false },
      );
      return;
    }
    const metas = await Promise.all(
      ids.map((id) => this.worldStore.getWorld(id)),
    );
    const active = metas.filter((meta): meta is NonNullable<typeof meta> =>
      Boolean(meta && meta.status === "active"),
    );
    if (active.length === 0) {
      await safeReply(
        interaction,
        pickByLanguage(
          language,
          "暂无已发布世界。",
          "No published worlds yet.",
        ),
        { ephemeral: false },
      );
      return;
    }
    const cards = await Promise.all(
      active.map((meta) => this.worldFiles.readWorldCard(meta.id)),
    );
    const lines = active.map((meta, idx) => {
      const summary = extractWorldOneLiner(cards[idx] ?? null);
      return pickByLanguage(
        language,
        summary
          ? `W${meta.id} ${meta.name} — ${summary}（入口 guild:${meta.homeGuildId}）`
          : `W${meta.id} ${meta.name}（入口 guild:${meta.homeGuildId}）`,
        summary
          ? `W${meta.id} ${meta.name} — ${summary} (entry guild:${meta.homeGuildId})`
          : `W${meta.id} ${meta.name} (entry guild:${meta.homeGuildId})`,
      );
    });
    await safeReply(interaction, lines.join("\n"), { ephemeral: false });
  }

  private async handleWorldInfo(
    interaction: ChatInputCommandInteraction,
    worldId: number,
  ): Promise<void> {
    const language = await this.userState
      .getLanguage(interaction.user.id)
      .catch(() => null);
    await safeDefer(interaction, { ephemeral: false });
    const meta = await this.worldStore.getWorld(worldId);
    if (!meta) {
      await safeReply(
        interaction,
        pickByLanguage(
          language,
          `世界不存在：W${worldId}`,
          `World not found: W${worldId}`,
        ),
        { ephemeral: false },
      );
      return;
    }
    if (meta.status === "draft" && meta.creatorId !== interaction.user.id) {
      await safeReply(
        interaction,
        pickByLanguage(
          language,
          `世界尚未发布：W${meta.id}（仅创作者可见）`,
          `World not published yet: W${meta.id} (creator only)`,
        ),
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
    const statusLabel = pickByLanguage(
      language,
      meta.status === "draft" ? "draft(未发布)" : meta.status,
      meta.status === "draft" ? "draft (unpublished)" : meta.status,
    );
    const channels =
      meta.status === "draft"
        ? null
        : pickByLanguage(
            language,
            [
              `公告：<#${meta.infoChannelId}>`,
              `讨论：<#${meta.roleplayChannelId}>`,
              `提案：<#${meta.proposalsChannelId}>`,
              `加入：\`/world join world_id:${meta.id}\``,
            ].join("\n"),
            [
              `Announcements: <#${meta.infoChannelId}>`,
              `Discussion: <#${meta.roleplayChannelId}>`,
              `Proposals: <#${meta.proposalsChannelId}>`,
              `Join: \`/world join world_id:${meta.id}\``,
            ].join("\n"),
          );

    const patchedCard =
      card?.trim() && meta.creatorId
        ? patchCreatorLineInMarkdown(card.trim(), meta.creatorId, creatorLabel)
        : card?.trim()
          ? card.trim()
          : "";
    const summary = extractWorldOneLiner(patchedCard) ?? "";

    const embeds: APIEmbed[] = [
      {
        title: `W${meta.id} ${meta.name}`,
        description: summary || undefined,
        fields: [
          {
            name: pickByLanguage(language, "创作者", "Creator"),
            value: creatorLabel || `<@${meta.creatorId}>`,
            inline: true,
          },
          {
            name: pickByLanguage(language, "状态", "Status"),
            value: statusLabel,
            inline: true,
          },
          {
            name: pickByLanguage(language, "入口", "Entry"),
            value: `guild:${meta.homeGuildId}`,
            inline: true,
          },
          {
            name: pickByLanguage(language, "统计", "Stats"),
            value: pickByLanguage(
              language,
              `访客数：${stats.visitorCount}\n角色数：${stats.characterCount}`,
              `Visitors: ${stats.visitorCount}\nCharacters: ${stats.characterCount}`,
            ),
            inline: true,
          },
          ...(channels
            ? [
                {
                  name: pickByLanguage(language, "频道", "Channels"),
                  value: channels,
                  inline: false,
                },
              ]
            : []),
        ],
      },
      ...buildMarkdownCardEmbeds(patchedCard, {
        titlePrefix: pickByLanguage(language, "世界卡", "World Card"),
        maxEmbeds: 18,
        includeEmptyFields: true,
      }),
    ];

    for (const chunk of chunkEmbedsForDiscord(embeds, 10)) {
      await safeReplyRich(interaction, { embeds: chunk }, { ephemeral: false });
    }
  }

  private async handleWorldRules(
    interaction: ChatInputCommandInteraction,
    worldId: number,
  ): Promise<void> {
    const language = await this.userState
      .getLanguage(interaction.user.id)
      .catch(() => null);
    await safeDefer(interaction, { ephemeral: false });
    const meta = await this.worldStore.getWorld(worldId);
    if (!meta) {
      await safeReply(
        interaction,
        pickByLanguage(
          language,
          `世界不存在：W${worldId}`,
          `World not found: W${worldId}`,
        ),
        { ephemeral: false },
      );
      return;
    }
    if (meta.status === "draft" && meta.creatorId !== interaction.user.id) {
      await safeReply(
        interaction,
        pickByLanguage(
          language,
          `世界尚未发布：W${meta.id}（仅创作者可见）`,
          `World not published yet: W${meta.id} (creator only)`,
        ),
        {
          ephemeral: false,
        },
      );
      return;
    }
    const rules = await this.worldFiles.readRules(meta.id);
    const patchedRules = rules?.trim() ? rules.trim() : "";

    const embeds: APIEmbed[] = [
      {
        title: pickByLanguage(
          language,
          `W${meta.id} ${meta.name} — 世界规则`,
          `W${meta.id} ${meta.name} — World Rules`,
        ),
      },
      ...buildMarkdownCardEmbeds(patchedRules, {
        titlePrefix: pickByLanguage(language, "世界规则", "World Rules"),
        maxEmbeds: 18,
        includeEmptyFields: true,
      }),
    ];
    for (const chunk of chunkEmbedsForDiscord(embeds, 10)) {
      await safeReplyRich(interaction, { embeds: chunk }, { ephemeral: false });
    }
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
    const language = await this.userState
      .getLanguage(interaction.user.id)
      .catch(() => null);
    const payload = buildWorldSubmissionMarkdown({
      worldId: meta.id,
      worldName: meta.name,
      submissionId,
      kind: input.kind,
      title: input.title,
      content: input.content,
      submitterUserId: interaction.user.id,
      createdAt: nowIso,
      language,
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
    const language = await this.userState
      .getLanguage(interaction.user.id)
      .catch(() => null);
    await safeDefer(interaction, { ephemeral: true });
    const meta = await this.worldStore.getWorld(input.worldId);
    if (!meta) {
      await safeReply(
        interaction,
        pickByLanguage(
          language,
          `世界不存在：W${input.worldId}`,
          `World not found: W${input.worldId}`,
        ),
        { ephemeral: true },
      );
      return;
    }
    if (meta.status !== "active") {
      await safeReply(
        interaction,
        pickByLanguage(
          language,
          `无法加入：世界尚未发布（W${meta.id} 当前状态=${meta.status}）`,
          `Cannot join: world is not published yet (W${meta.id} status=${meta.status})`,
        ),
        { ephemeral: true },
      );
      return;
    }
    if (!interaction.guildId || interaction.guildId !== meta.homeGuildId) {
      await safeReply(
        interaction,
        pickByLanguage(
          language,
          `无法加入：该世界入口在 guild:${meta.homeGuildId}（请先加入该服务器后再执行 /world join）。`,
          `Cannot join: this world's entry server is guild:${meta.homeGuildId} (join that server first, then run /world join).`,
        ),
        { ephemeral: true },
      );
      return;
    }
    if (!interaction.guild) {
      await safeReply(
        interaction,
        pickByLanguage(
          language,
          "无法获取服务器信息，请稍后重试。",
          "Failed to fetch server info. Please try again later.",
        ),
        { ephemeral: true },
      );
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
        pickByLanguage(
          language,
          [
            `已加入世界：W${meta.id} ${meta.name}`,
            `讨论：<#${meta.roleplayChannelId}>`,
            `当前角色：C${worldCharacter.characterId}${
              worldCharacter.forked
                ? `（本世界专用，fork自 C${worldCharacter.sourceCharacterId}）`
                : ""
            }`,
          ].join("\n"),
          [
            `Joined world: W${meta.id} ${meta.name}`,
            `Discussion: <#${meta.roleplayChannelId}>`,
            `Active character: C${worldCharacter.characterId}${
              worldCharacter.forked
                ? ` (world-specific; forked from C${worldCharacter.sourceCharacterId})`
                : ""
            }`,
          ].join("\n"),
        ),
        { ephemeral: true },
      );
    } catch (err) {
      await safeReply(
        interaction,
        pickByLanguage(
          language,
          `加入失败：${err instanceof Error ? err.message : String(err)}`,
          `Failed to join: ${err instanceof Error ? err.message : String(err)}`,
        ),
        { ephemeral: true },
      );
    }
  }

  private async handleWorldStats(
    interaction: ChatInputCommandInteraction,
    worldId: number,
  ): Promise<void> {
    await safeDefer(interaction, { ephemeral: false });
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
    const language = await this.userState
      .getLanguage(interaction.user.id)
      .catch(() => null);
    await safeDefer(interaction, { ephemeral: false });
    const query = input.query.trim();
    if (!query) {
      await safeReply(
        interaction,
        pickByLanguage(
          language,
          "query 不能为空。",
          "query must not be empty.",
        ),
        { ephemeral: false },
      );
      return;
    }
    const limit = Math.max(1, Math.min(50, Math.floor(input.limit ?? 10)));

    const ids = await this.worldStore.listWorldIds(200);
    if (ids.length === 0) {
      await safeReply(
        interaction,
        pickByLanguage(language, "暂无世界。", "No worlds yet."),
        { ephemeral: false },
      );
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
          pickByLanguage(
            language,
            summary
              ? `W${meta.id} ${meta.name} — ${summary}（命中：name）`
              : `W${meta.id} ${meta.name}（命中：name）`,
            summary
              ? `W${meta.id} ${meta.name} — ${summary} (hit: name)`
              : `W${meta.id} ${meta.name} (hit: name)`,
          ),
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
          pickByLanguage(
            language,
            summary
              ? `W${meta.id} ${meta.name} — ${summary}（命中：world-card）`
              : `W${meta.id} ${meta.name}（命中：world-card）`,
            summary
              ? `W${meta.id} ${meta.name} — ${summary} (hit: world-card)`
              : `W${meta.id} ${meta.name} (hit: world-card)`,
          ),
        );
        continue;
      }
      if (rules?.toLowerCase().includes(lowered)) {
        const summary = extractWorldOneLiner(card);
        results.push(
          pickByLanguage(
            language,
            summary
              ? `W${meta.id} ${meta.name} — ${summary}（命中：rules）`
              : `W${meta.id} ${meta.name}（命中：rules）`,
            summary
              ? `W${meta.id} ${meta.name} — ${summary} (hit: rules)`
              : `W${meta.id} ${meta.name} (hit: rules)`,
          ),
        );
      }
    }

    if (results.length === 0) {
      await safeReply(
        interaction,
        pickByLanguage(
          language,
          `未找到包含「${query}」的世界。`,
          `No worlds matched "${query}".`,
        ),
        { ephemeral: false },
      );
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
      `该指令已弃用：请使用 /world open world_id:${input.worldId} 打开编辑话题，然后在编辑话题里继续编辑并 /world publish 发布。`,
      { ephemeral: true },
    );
  }

  private async handleWorldDone(
    interaction: ChatInputCommandInteraction,
  ): Promise<void> {
    await safeReply(
      interaction,
      "请在世界编辑话题中执行 /world publish 发布。",
      {
        ephemeral: true,
      },
    );
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
          ? `已删除频道/角色等资源：${deleted.length}`
          : "频道/角色等资源删除：跳过/失败（请手工检查）",
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
    if (subcommand === "export") {
      const characterId =
        interaction.options.getInteger("character_id") ?? undefined;
      await this.handleCharacterExport(interaction, { characterId });
      return;
    }
    if (subcommand === "import") {
      const file = interaction.options.getAttachment("file", true);
      const characterId =
        interaction.options.getInteger("character_id") ?? undefined;
      await this.handleCharacterImport(interaction, { file, characterId });
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
    const language = await this.userState
      .getLanguage(interaction.user.id)
      .catch(() => null);
    if (!interaction.guildId || !interaction.guild) {
      await safeReply(
        interaction,
        pickByLanguage(
          language,
          "该指令仅支持在服务器内使用。",
          "This command can only be used in a server.",
        ),
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
    await safeDefer(interaction, { ephemeral: true });
    let characterId: number | null = null;
    try {
      const visibilityRaw =
        (interaction.options.getString(
          "visibility",
        ) as CharacterVisibility | null) ?? "private";
      const visibility: CharacterVisibility =
        visibilityRaw === "public" ? "public" : "private";
      const description =
        interaction.options.getString("description")?.trim() ?? "";
      const nameRaw = interaction.options.getString("name")?.trim() ?? "";

      characterId = await this.worldStore.nextCharacterId();
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
          language,
        }),
      );
      const source = {
        filename: "source.md",
        content: buildCharacterSourceSeedContent(language),
      };
      await this.worldFiles.writeCharacterSourceDocument(characterId, source);
      await this.worldFiles.appendCharacterEvent(characterId, {
        type: "character_created",
        characterId,
        userId: interaction.user.id,
      });
      await this.worldFiles.appendCharacterEvent(characterId, {
        type: "character_source_uploaded",
        characterId,
        userId: interaction.user.id,
        filename: source.filename,
      });
      await this.userState.markCharacterCreated(interaction.user.id);

      await this.ensureCharacterBuildGroupAgent({
        characterId,
        characterName: name,
        language,
      });

      const workshop = await this.createCreatorOnlyChannel({
        guild: interaction.guild,
        name: `character-workshop-${interaction.user.id}`,
        creatorUserId: interaction.user.id,
        reason: `character workshop ensure for ${interaction.user.id}`,
      });
      const thread = await this.tryCreatePrivateThread({
        guild: interaction.guild,
        parentChannelId: workshop.id,
        name: pickByLanguage(
          language,
          `角色创建 C${characterId}`,
          `Character Create C${characterId}`,
        ),
        reason: `character create C${characterId} by ${interaction.user.id}`,
        memberUserId: interaction.user.id,
      });

      const buildConversationChannelId = thread?.threadId ?? workshop.id;
      const buildConversationMention = `<#${buildConversationChannelId}>`;

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
        language,
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
        pickByLanguage(
          language,
          [
            `角色已创建：C${characterId} ${name}（visibility=${visibility}）`,
            `完善角色卡：${buildConversationMention}`,
            `设为默认角色：/character use character_id:${characterId}`,
            thread
              ? ""
              : "提示：当前无法创建私密话题，已降级为工作坊频道（请检查 bot 的线程权限）。",
          ]
            .filter(Boolean)
            .join("\n"),
          [
            `Character created: C${characterId} ${name} (visibility=${visibility})`,
            `Continue editing: ${buildConversationMention}`,
            `Set as default: /character use character_id:${characterId}`,
            thread
              ? ""
              : "Note: Failed to create a private thread; fell back to the workshop channel (check the bot's thread permissions).",
          ]
            .filter(Boolean)
            .join("\n"),
        ),
        { ephemeral: true },
      );
    } catch (err) {
      this.logger.error({ err }, "Failed to create character");
      feishuLogJson({
        event: "discord.character.create.error",
        traceId,
        interactionId: interaction.id,
        characterId: characterId ?? undefined,
        errName: err instanceof Error ? err.name : "Error",
        errMessage: err instanceof Error ? err.message : String(err),
      });
      await safeReply(
        interaction,
        pickByLanguage(
          language,
          [
            `创建失败：${err instanceof Error ? err.message : String(err)}`,
            characterId ? `（角色可能已创建：C${characterId}）` : "",
          ]
            .filter(Boolean)
            .join("\n"),
          [
            `Failed: ${err instanceof Error ? err.message : String(err)}`,
            characterId ? `(Character may already exist: C${characterId})` : "",
          ]
            .filter(Boolean)
            .join("\n"),
        ),
        { ephemeral: true },
      );
    }
  }

  private async handleCharacterHelp(
    interaction: ChatInputCommandInteraction,
  ): Promise<void> {
    const language = await this.userState
      .getLanguage(interaction.user.id)
      .catch(() => null);
    await safeReply(interaction, buildDiscordCharacterHelp(language), {
      ephemeral: true,
    });
  }

  private async handleCharacterExport(
    interaction: ChatInputCommandInteraction,
    input: { characterId?: number },
  ): Promise<void> {
    await safeDefer(interaction, { ephemeral: true });
    let characterId: number;
    try {
      characterId = await this.resolveCharacterIdFromInteraction(
        interaction,
        input.characterId,
      );
    } catch (err) {
      await safeReply(
        interaction,
        err instanceof Error ? err.message : String(err),
        { ephemeral: true },
      );
      return;
    }

    const meta = await this.worldStore.getCharacter(characterId);
    if (!meta) {
      await safeReply(interaction, `角色不存在：C${characterId}`, {
        ephemeral: true,
      });
      return;
    }
    if (meta.creatorId !== interaction.user.id) {
      await safeReply(interaction, "无权限：只有角色创作者可以导出角色卡。", {
        ephemeral: true,
      });
      return;
    }

    const content = await this.worldFiles.readCharacterCard(meta.id);
    if (content === null) {
      await safeReply(interaction, `角色卡文件不存在：C${meta.id}`, {
        ephemeral: true,
      });
      return;
    }

    await safeReplyRich(
      interaction,
      {
        content: [
          `已导出角色卡：C${meta.id} ${meta.name}`,
          "改完后把文件作为附件上传，然后用 /character import 覆盖角色卡。",
          "支持 .md/.txt（会覆盖原内容）。",
        ].join("\n"),
        files: [
          {
            attachment: Buffer.from(content, "utf8"),
            name: `C${meta.id}-character.md`,
          },
        ],
      },
      { ephemeral: true },
    );
  }

  private async handleCharacterImport(
    interaction: ChatInputCommandInteraction,
    input: { file: Attachment; characterId?: number },
  ): Promise<void> {
    await safeDefer(interaction, { ephemeral: true });
    let characterId: number;
    try {
      characterId = await this.resolveCharacterIdFromInteraction(
        interaction,
        input.characterId,
      );
    } catch (err) {
      await safeReply(
        interaction,
        err instanceof Error ? err.message : String(err),
        { ephemeral: true },
      );
      return;
    }

    const meta = await this.worldStore.getCharacter(characterId);
    if (!meta) {
      await safeReply(interaction, `角色不存在：C${characterId}`, {
        ephemeral: true,
      });
      return;
    }
    if (meta.creatorId !== interaction.user.id) {
      await safeReply(interaction, "无权限：只有角色创作者可以覆盖角色卡。", {
        ephemeral: true,
      });
      return;
    }

    let doc: { filename: string; content: string };
    try {
      doc = await fetchDiscordTextAttachment(input.file, {
        logger: this.logger,
        maxBytes: DEFAULT_DISCORD_TEXT_ATTACHMENT_MAX_BYTES,
      });
    } catch (err) {
      await safeReply(
        interaction,
        `读取附件失败：${err instanceof Error ? err.message : String(err)}`,
        { ephemeral: true },
      );
      return;
    }

    if (!isAllowedWikiImportFilename(doc.filename)) {
      await safeReply(interaction, "仅支持导入 .md/.markdown/.txt 文件。", {
        ephemeral: true,
      });
      return;
    }

    await this.worldFiles.writeCharacterCard(meta.id, doc.content);
    await this.worldFiles.appendCharacterEvent(meta.id, {
      type: "character_card_imported",
      characterId: meta.id,
      userId: interaction.user.id,
      filename: doc.filename,
    });

    await safeReply(
      interaction,
      `已覆盖角色卡：C${meta.id} ${meta.name}（来源：${doc.filename}）`,
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

    const ephemeral = meta.visibility === "private";
    await safeDefer(interaction, { ephemeral });

    const card = await this.worldFiles.readCharacterCard(meta.id);
    if (!card) {
      await safeReply(interaction, "角色卡缺失（待修复）。", {
        ephemeral,
      });
      return;
    }
    const creatorLabel = await this.resolveDiscordUserLabel({
      userId: meta.creatorId,
      guild: interaction.guild ?? null,
    });
    const patched = card.trim();

    const embeds: APIEmbed[] = [
      {
        title: `C${meta.id} ${meta.name}`,
        fields: [
          {
            name: "创建者",
            value: creatorLabel || `<@${meta.creatorId}>`,
            inline: true,
          },
          { name: "可见性", value: meta.visibility, inline: true },
          { name: "状态", value: meta.status, inline: true },
        ],
      },
      ...buildMarkdownCardEmbeds(patched, {
        titlePrefix: "角色卡",
        maxEmbeds: 18,
        includeEmptyFields: true,
      }),
    ];

    for (const chunk of chunkEmbedsForDiscord(embeds, 10)) {
      await safeReplyRich(interaction, { embeds: chunk }, { ephemeral });
    }
  }

  private async handleCharacterAct(
    interaction: ChatInputCommandInteraction,
    characterId: number,
  ): Promise<void> {
    const language = await this.userState
      .getLanguage(interaction.user.id)
      .catch(() => null);
    await safeDefer(interaction, { ephemeral: false });
    const meta = await this.worldStore.getCharacter(characterId);
    if (!meta) {
      await safeReply(
        interaction,
        pickByLanguage(
          language,
          `角色不存在：C${characterId}`,
          `Character not found: C${characterId}`,
        ),
        { ephemeral: false },
      );
      return;
    }
    if (meta.creatorId !== interaction.user.id) {
      await safeReply(
        interaction,
        pickByLanguage(
          language,
          "无权限：只能使用你自己创建的角色。",
          "Permission denied: you can only use characters you created.",
        ),
        { ephemeral: false },
      );
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
        pickByLanguage(
          language,
          "请在目标世界频道内执行 /character act（或先 /world join 进入世界）。",
          "Run /character act inside the target world channels (or /world join first).",
        ),
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
      await safeReply(
        interaction,
        pickByLanguage(
          language,
          "你尚未加入该世界，无法设置当前角色。",
          "You haven't joined this world yet, so you can't set an active character.",
        ),
        { ephemeral: false },
      );
      return;
    }

    const worldMeta = await this.worldStore.getWorld(worldId);
    if (!worldMeta || worldMeta.status !== "active") {
      await safeReply(
        interaction,
        pickByLanguage(
          language,
          "当前世界不可用（尚未发布或已被移除）。",
          "World unavailable (unpublished or removed).",
        ),
        { ephemeral: false },
      );
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
      pickByLanguage(
        language,
        [
          `已设置你的当前角色：C${worldCharacter.characterId} ${
            worldCharacter.forked
              ? `（本世界专用，fork自 C${meta.id}）`
              : meta.name
          }`,
          `接下来你在世界入口频道的发言将视为该角色的行动/台词；bot 会作为旁白/世界系统回应。`,
        ].join("\n"),
        [
          `Active character set: C${worldCharacter.characterId} ${
            worldCharacter.forked
              ? `(world-specific; forked from C${meta.id})`
              : meta.name
          }`,
          "From now on, your messages in the world channels will be treated as this character's actions/dialogue; the bot will respond as the narrator/world system.",
        ].join("\n"),
      ),
      { ephemeral: false },
    );
  }

  private async handleCharacterOpen(
    interaction: ChatInputCommandInteraction,
    characterId: number,
  ): Promise<void> {
    const language = await this.userState
      .getLanguage(interaction.user.id)
      .catch(() => null);
    await safeDefer(interaction, { ephemeral: true });
    try {
      const meta = await this.worldStore.getCharacter(characterId);
      if (!meta) {
        await safeReply(
          interaction,
          pickByLanguage(
            language,
            `角色不存在：C${characterId}`,
            `Character not found: C${characterId}`,
          ),
          { ephemeral: true },
        );
        return;
      }
      if (meta.creatorId !== interaction.user.id) {
        await safeReply(
          interaction,
          pickByLanguage(
            language,
            "无权限：只有角色创作者可以编辑角色卡。",
            "Permission denied: only the character creator can edit this card.",
          ),
          { ephemeral: true },
        );
        return;
      }

      await this.ensureCharacterBuildGroupAgent({
        characterId: meta.id,
        characterName: meta.name,
        language,
      });

      if (!interaction.guildId || !interaction.guild) {
        await safeReply(
          interaction,
          pickByLanguage(
            language,
            "该指令仅支持在服务器内使用。",
            "This command can only be used in a server.",
          ),
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
      let degraded = false;
      if (fetched) {
        conversationChannelId = existingThreadId;
        await this.reopenPrivateThreadForUser(fetched, interaction.user.id, {
          reason: `character open C${meta.id}`,
        });
        try {
          const currentName =
            fetched && typeof fetched === "object" && "name" in fetched
              ? String((fetched as { name: unknown }).name ?? "")
              : "";
          const isCreateThread =
            currentName.startsWith("角色创建") ||
            currentName.startsWith("Character Create");
          const desiredName = pickByLanguage(
            language,
            isCreateThread ? `角色创建 C${meta.id}` : `角色编辑 C${meta.id}`,
            isCreateThread
              ? `Character Create C${meta.id}`
              : `Character Edit C${meta.id}`,
          );
          const setter =
            fetched && typeof fetched === "object" && "setName" in fetched
              ? (fetched as { setName?: unknown }).setName
              : null;
          if (
            typeof setter === "function" &&
            desiredName.trim() &&
            desiredName !== currentName
          ) {
            await (
              fetched as unknown as {
                setName: (name: string, reason?: string) => Promise<unknown>;
              }
            ).setName(desiredName, `character thread rename C${meta.id}`);
          }
        } catch {
          // ignore
        }
      } else {
        const thread = await this.tryCreatePrivateThread({
          guild: interaction.guild,
          parentChannelId: workshop.id,
          name: pickByLanguage(
            language,
            `角色编辑 C${meta.id}`,
            `Character Edit C${meta.id}`,
          ),
          reason: `character open C${meta.id} by ${interaction.user.id}`,
          memberUserId: interaction.user.id,
        });
        conversationChannelId = thread?.threadId ?? workshop.id;
        degraded = !thread;

        await this.worldStore.setCharacterBuildChannelId({
          characterId: meta.id,
          channelId: conversationChannelId,
        });
        await this.sendCharacterCreateRules({
          guildId: interaction.guildId,
          channelId: conversationChannelId,
          characterId: meta.id,
          language,
        });
      }

      await this.worldStore.setChannelGroupId(
        conversationChannelId,
        buildCharacterBuildGroupId(meta.id),
      );

      await safeReply(
        interaction,
        pickByLanguage(
          language,
          [
            `已打开角色卡编辑：C${meta.id} ${meta.name}`,
            `编辑话题：<#${conversationChannelId}>`,
            degraded
              ? "提示：当前无法创建私密话题，已降级为工作坊频道（请检查 bot 的线程权限）。"
              : "",
          ]
            .filter(Boolean)
            .join("\n"),
          [
            `Character editor opened: C${meta.id} ${meta.name}`,
            `Thread: <#${conversationChannelId}>`,
            degraded
              ? "Note: Failed to create a private thread; fell back to the workshop channel (check the bot's thread permissions)."
              : "",
          ]
            .filter(Boolean)
            .join("\n"),
        ),
        { ephemeral: true },
      );
    } catch (err) {
      this.logger.error(
        { err, characterId },
        "Failed to open character editor",
      );
      await safeReply(
        interaction,
        pickByLanguage(
          language,
          `打开失败：${err instanceof Error ? err.message : String(err)}`,
          `Failed: ${err instanceof Error ? err.message : String(err)}`,
        ),
        { ephemeral: true },
      );
    }
  }

  private async handleCharacterUse(
    interaction: ChatInputCommandInteraction,
    characterId: number,
  ): Promise<void> {
    const language = await this.userState
      .getLanguage(interaction.user.id)
      .catch(() => null);
    const meta = await this.worldStore.getCharacter(characterId);
    if (!meta) {
      await safeReply(
        interaction,
        pickByLanguage(
          language,
          `角色不存在：C${characterId}`,
          `Character not found: C${characterId}`,
        ),
        { ephemeral: false },
      );
      return;
    }
    if (meta.creatorId !== interaction.user.id) {
      await safeReply(
        interaction,
        pickByLanguage(
          language,
          "无权限：只能使用你自己创建的角色。",
          "Permission denied: you can only use characters you created.",
        ),
        { ephemeral: false },
      );
      return;
    }
    await this.worldStore.setGlobalActiveCharacter({
      userId: interaction.user.id,
      characterId: meta.id,
    });
    await safeReply(
      interaction,
      pickByLanguage(
        language,
        `已设置你的默认角色：C${meta.id} ${meta.name}`,
        `Default character set: C${meta.id} ${meta.name}`,
      ),
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
    await safeReply(interaction, `已设为不公开：C${meta.id} ${meta.name}`, {
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
    return this.resolveCharacterIdFromInteraction(interaction, characterId);
  }

  private async resolveCharacterIdFromInteraction(
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
    throw new Error("缺少 character_id：请显式提供，或在角色编辑话题中执行。");
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

    const language = await this.userState
      .getLanguage(input.userId)
      .catch(() => null);
    await this.ensureWorldCharacterBuildGroupAgent({
      worldId: input.worldId,
      worldName: input.worldName,
      characterId: input.characterId,
      characterName,
      language,
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
        `你可以在本话题继续补充信息（不需要 @）。`,
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
      "角色编辑话题不需要关闭（长期保留）。如需继续编辑：/character open character_id:<角色ID>。",
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

    let thread: {
      id: string;
      members?: { add: (userId: string) => Promise<unknown> };
    };
    try {
      thread = await (
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
    } catch (err) {
      this.logger.warn(
        { err, parentChannelId: resolvedParentId, threadName: input.name },
        "Failed to create private thread",
      );
      return null;
    }

    try {
      await thread.members?.add(input.memberUserId);
    } catch (err) {
      this.logger.warn(
        { err, threadId: thread.id, memberUserId: input.memberUserId },
        "Failed to add member to private thread",
      );
      try {
        const deleter = (thread as unknown as { delete?: unknown }).delete;
        if (typeof deleter === "function") {
          await (
            thread as unknown as {
              delete: (reason?: string) => Promise<unknown>;
            }
          ).delete(input.reason);
        }
      } catch {
        // ignore
      }
      return null;
    }

    const parentChannelId =
      parentChannel &&
      typeof parentChannel === "object" &&
      "id" in parentChannel &&
      typeof (parentChannel as { id?: unknown }).id === "string"
        ? ((parentChannel as { id: string }).id as string)
        : resolvedParentId;
    return { threadId: thread.id, parentChannelId };
  }

  private async reopenPrivateThreadForUser(
    channel: unknown,
    userId: string,
    input: { reason: string },
  ): Promise<void> {
    try {
      const setArchived = (channel as unknown as { setArchived?: unknown })
        .setArchived;
      if (typeof setArchived === "function") {
        await (
          channel as unknown as {
            setArchived: (
              archived: boolean,
              reason?: string,
            ) => Promise<unknown>;
          }
        ).setArchived(false, input.reason);
      }
    } catch {
      // ignore
    }

    try {
      const members = (channel as unknown as { members?: unknown }).members;
      const add =
        members && typeof members === "object"
          ? (members as { add?: unknown }).add
          : null;
      if (typeof add === "function") {
        await (members as { add: (userId: string) => Promise<unknown> }).add(
          userId,
        );
      }
    } catch {
      // ignore
    }
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
      try {
        const botUserId = this.botUserId ?? this.client.user?.id ?? "";
        if (botUserId) {
          const overwrites = buildDraftCreatorOnlyOverwrites({
            everyoneRoleId: input.guild.roles.everyone.id,
            creatorUserId: input.creatorUserId,
            botUserId,
          });
          const setter = (
            existing as unknown as {
              permissionOverwrites?: { set?: unknown };
            }
          ).permissionOverwrites?.set;
          if (typeof setter === "function") {
            await (
              existing as unknown as {
                permissionOverwrites: {
                  set: (
                    overwrites: Array<{
                      id: string;
                      allow?: bigint[];
                      deny?: bigint[];
                    }>,
                    reason?: string,
                  ) => Promise<unknown>;
                };
              }
            ).permissionOverwrites.set(overwrites, input.reason);
          }
        }
      } catch {
        // ignore
      }
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

  private async ensureOnboardingThread(input: {
    guild: Guild;
    userId: string;
    role: UserRole;
    language: UserLanguage | null | undefined;
    reason: string;
  }): Promise<string> {
    const workshop = await this.createCreatorOnlyChannel({
      guild: input.guild,
      name: `onboarding-${input.userId}`,
      creatorUserId: input.userId,
      reason: `onboarding workshop ensure for ${input.userId}`,
    });

    const existingThreadId = await this.userState.getOnboardingThreadId({
      userId: input.userId,
      role: input.role,
    });
    if (existingThreadId) {
      const fetched = await input.guild.channels
        .fetch(existingThreadId)
        .catch(() => null);
      if (fetched) {
        try {
          const setArchived = (fetched as unknown as { setArchived?: unknown })
            .setArchived;
          if (typeof setArchived === "function") {
            await (
              fetched as unknown as {
                setArchived: (
                  archived: boolean,
                  reason?: string,
                ) => Promise<unknown>;
              }
            ).setArchived(false, "onboarding reopen");
          }
        } catch {
          // ignore
        }
        try {
          const members = (fetched as unknown as { members?: unknown }).members;
          const add =
            members && typeof members === "object"
              ? (members as { add?: unknown }).add
              : null;
          if (typeof add === "function") {
            await (
              members as { add: (userId: string) => Promise<unknown> }
            ).add(input.userId);
          }
        } catch {
          // ignore
        }
        return existingThreadId;
      }
    }

    const thread = await this.tryCreatePrivateThread({
      guild: input.guild,
      parentChannelId: workshop.id,
      name: pickByLanguage(
        input.language,
        input.role === "admin"
          ? "管理员指南"
          : input.role === "world creater"
            ? "世界创建者指南"
            : "冒险者指南",
        input.role === "admin"
          ? "Admin Guide"
          : input.role === "world creater"
            ? "World Creater Guide"
            : "Adventurer Guide",
      ),
      reason: input.reason,
      memberUserId: input.userId,
    });
    const channelId = thread?.threadId ?? workshop.id;
    await this.userState.setOnboardingThreadId({
      userId: input.userId,
      role: input.role,
      threadId: channelId,
    });
    return channelId;
  }

  private async migrateWorldAgents(): Promise<void> {
    const ids = await this.worldStore.listWorldIds(200);
    for (const id of ids) {
      const meta = await this.worldStore.getWorld(id);
      if (!meta) {
        continue;
      }
      try {
        const language = await this.userState
          .getLanguage(meta.creatorId)
          .catch(() => null);
        await this.ensureWorldBuildGroupAgent({
          worldId: meta.id,
          worldName: meta.name,
          language,
        });
        if (meta.status !== "draft") {
          await this.ensureWorldGroupAgent({
            worldId: meta.id,
            worldName: meta.name,
            language,
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

  private async sendRichToChannel(input: {
    guildId?: string;
    channelId: string;
    content?: string;
    embeds?: APIEmbed[];
    files?: Array<{ name: string; content: string }>;
    traceId?: string;
  }): Promise<void> {
    const botId = this.botUserId?.trim() ?? this.client.user?.id ?? "";
    if (!botId) {
      return;
    }

    const content = input.content?.trim() ?? "";
    const embeds = input.embeds ?? [];
    const files = (input.files ?? [])
      .map((file) => ({
        name: file.name?.trim() ?? "",
        content: file.content ?? "",
      }))
      .filter((file) => Boolean(file.name));
    if (!content && embeds.length === 0 && files.length === 0) {
      return;
    }

    const channel = await this.client.channels
      .fetch(input.channelId)
      .catch(() => null);
    if (!channel || typeof channel !== "object") {
      return;
    }
    if (
      !("send" in channel) ||
      typeof (channel as { send?: unknown }).send !== "function"
    ) {
      return;
    }

    const payload: {
      content?: string;
      embeds?: APIEmbed[];
      files?: Array<{ attachment: Buffer; name: string }>;
    } = {};
    if (content) {
      payload.content = content;
    }
    if (embeds.length > 0) {
      payload.embeds = embeds;
    }
    if (files.length > 0) {
      payload.files = files
        .map((file) => {
          const buf = Buffer.from(file.content ?? "", "utf8") as Buffer;
          if (buf.byteLength > DEFAULT_DISCORD_TEXT_ATTACHMENT_MAX_BYTES) {
            return null;
          }
          return { attachment: buf, name: file.name };
        })
        .filter((file): file is { attachment: Buffer; name: string } =>
          Boolean(file),
        );
    }

    if (
      !payload.content &&
      (!payload.embeds || payload.embeds.length === 0) &&
      (!payload.files || payload.files.length === 0)
    ) {
      return;
    }

    try {
      const sent = await (
        channel as { send: (payload: unknown) => Promise<unknown> }
      ).send(payload);
      const messageId =
        sent && typeof sent === "object" && "id" in sent ? String(sent.id) : "";
      feishuLogJson({
        event: "io.send",
        platform: "discord",
        traceId: input.traceId,
        channelId: input.channelId,
        botId,
        messageId,
        contentPreview: previewTextForLog(payload.content ?? "", 1200),
        contentLength: payload.content?.length ?? 0,
        hasFiles: Boolean(payload.files && payload.files.length > 0),
        hasEmbeds: Boolean(payload.embeds && payload.embeds.length > 0),
      });
    } catch (err) {
      this.logger.warn(
        { err, channelId: input.channelId },
        "Failed to send rich message",
      );
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
    const patchedCard =
      card?.trim() && meta?.creatorId
        ? patchCreatorLineInMarkdown(card.trim(), meta.creatorId, creatorLabel)
        : card?.trim()
          ? card.trim()
          : "";
    const patchedRules = rules?.trim() ? rules.trim() : "";

    const embeds: APIEmbed[] = [
      {
        title: `【世界信息】W${input.worldId} ${input.worldName}`,
        description: [
          `更新时间：${nowIso}`,
          creatorLabel ? `创作者：${creatorLabel}` : null,
          `访客数：${stats.visitorCount} 角色数：${stats.characterCount}`,
          `加入：\`/world join world_id:${input.worldId}\``,
        ]
          .filter((line): line is string => Boolean(line))
          .join("\n"),
      },
      ...buildMarkdownCardEmbeds(patchedCard, {
        titlePrefix: "世界卡",
        maxEmbeds: 4,
        includeEmptyFields: true,
      }),
      ...buildMarkdownCardEmbeds(patchedRules, {
        titlePrefix: "世界规则",
        maxEmbeds: 4,
        includeEmptyFields: true,
      }),
    ];

    for (const chunk of chunkEmbedsForDiscord(embeds, 10)) {
      await this.sendRichToChannel({
        guildId: input.guildId,
        channelId: input.infoChannelId,
        embeds: chunk,
        traceId: input.traceId,
      });
    }
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

  private async publishWorldShowcasePost(input: {
    guild: Guild;
    worldId: number;
    worldName: string;
    creatorId: string;
    language: UserLanguage | null;
  }): Promise<void> {
    const exists = await this.worldStore.getWorldShowcasePost(input.worldId);
    if (exists) {
      return;
    }

    const botUserId = this.botUserId ?? this.client.user?.id ?? "";
    if (!botUserId) {
      return;
    }

    const showcase = await this.ensureWorldShowcaseChannel({
      guild: input.guild,
      botUserId,
      reason: `world showcase ensure for W${input.worldId}`,
    });
    const channel = await input.guild.channels
      .fetch(showcase.channelId)
      .catch(() => null);
    if (!channel) {
      return;
    }

    const threadName = `W${input.worldId} ${input.worldName}`.slice(0, 100);
    const reason = `world publish W${input.worldId}`;

    const [card, rules] = await Promise.all([
      this.worldFiles.readWorldCard(input.worldId),
      this.worldFiles.readRules(input.worldId),
    ]);
    const opener = buildWorldShowcaseForumOpener({
      worldId: input.worldId,
      worldName: input.worldName,
      creatorId: input.creatorId,
      language: input.language,
      card,
    });

    let threadId: string | null = null;
    if (showcase.mode === "forum") {
      const creator = (
        channel as unknown as {
          threads?: {
            create?: (input: Record<string, unknown>) => Promise<unknown>;
          };
        }
      ).threads?.create;
      if (typeof creator === "function") {
        const created = await (
          channel as unknown as {
            threads: {
              create: (
                input: Record<string, unknown>,
              ) => Promise<{ id: string }>;
            };
          }
        ).threads.create({
          name: threadName,
          message: {
            content: opener,
          },
          reason,
        });
        threadId = created.id;
      }
    } else {
      const creator = (
        channel as unknown as {
          threads?: {
            create?: (input: Record<string, unknown>) => Promise<unknown>;
          };
        }
      ).threads?.create;
      if (typeof creator === "function") {
        const created = await (
          channel as unknown as {
            threads: {
              create: (
                input: Record<string, unknown>,
              ) => Promise<{ id: string }>;
            };
          }
        ).threads.create({
          name: threadName,
          type: ChannelType.PublicThread,
          autoArchiveDuration: 10080,
          reason,
        });
        threadId = created.id;
      }
    }
    if (!threadId) {
      return;
    }

    const payload = buildWorldShowcasePost({
      worldId: input.worldId,
      worldName: input.worldName,
      creatorId: input.creatorId,
      language: input.language,
      card,
      rules,
    });
    const messageId = await this.sendRichToChannelAndGetId({
      channelId: threadId,
      content: payload.content,
      embeds: payload.embeds,
    });
    if (!messageId) {
      return;
    }

    await this.worldStore.setWorldShowcasePost({
      worldId: input.worldId,
      channelId: showcase.channelId,
      threadId,
      messageId,
    });
  }

  private async ensureWorldShowcaseChannel(input: {
    guild: Guild;
    botUserId: string;
    reason: string;
  }): Promise<{ channelId: string; mode: "forum" | "text" }> {
    const channelName = "world-showcase";
    const overwrites = buildWorldShowcaseOverwrites({
      everyoneRoleId: input.guild.roles.everyone.id,
      botUserId: input.botUserId,
    });

    const existing = input.guild.channels.cache.find(
      (candidate) =>
        (candidate.type === ChannelType.GuildForum ||
          candidate.type === ChannelType.GuildText) &&
        candidate.name === channelName,
    );
    if (existing) {
      try {
        const setter = (
          existing as unknown as { permissionOverwrites?: { set?: unknown } }
        ).permissionOverwrites?.set;
        if (typeof setter === "function") {
          await (
            existing as unknown as {
              permissionOverwrites: {
                set: (
                  overwrites: Array<{
                    id: string;
                    allow?: bigint[];
                    deny?: bigint[];
                  }>,
                  reason?: string,
                ) => Promise<unknown>;
              };
            }
          ).permissionOverwrites.set(overwrites, input.reason);
        }
      } catch {
        // ignore
      }
      return {
        channelId: existing.id,
        mode: existing.type === ChannelType.GuildForum ? "forum" : "text",
      };
    }

    try {
      const forum = await input.guild.channels.create({
        name: channelName,
        type: ChannelType.GuildForum,
        permissionOverwrites: overwrites,
        reason: input.reason,
      });
      return { channelId: forum.id, mode: "forum" };
    } catch (err) {
      this.logger.warn(
        { err },
        "Failed to create forum channel; fallback to text",
      );
    }

    const text = await input.guild.channels.create({
      name: channelName,
      type: ChannelType.GuildText,
      permissionOverwrites: overwrites,
      reason: input.reason,
    });
    return { channelId: text.id, mode: "text" };
  }

  private async sendRichToChannelAndGetId(input: {
    channelId: string;
    content?: string;
    embeds?: APIEmbed[];
  }): Promise<string | null> {
    const channel = await this.client.channels
      .fetch(input.channelId)
      .catch(() => null);
    if (!channel || typeof channel !== "object") {
      return null;
    }
    if (
      !("send" in channel) ||
      typeof (channel as { send?: unknown }).send !== "function"
    ) {
      return null;
    }
    const payload: { content?: string; embeds?: APIEmbed[] } = {};
    const content = input.content?.trim() ?? "";
    if (content) {
      payload.content = content;
    }
    if (input.embeds && input.embeds.length > 0) {
      payload.embeds = input.embeds;
    }
    if (!payload.content && (!payload.embeds || payload.embeds.length === 0)) {
      return null;
    }

    const sent = await (
      channel as { send: (payload: unknown) => Promise<unknown> }
    ).send(payload);
    if (!sent || typeof sent !== "object" || !("id" in sent)) {
      return null;
    }
    const id = String(sent.id);
    return id.trim() ? id : null;
  }

  private async sendWorldCreateRules(input: {
    guildId?: string;
    channelId: string;
    worldId: number;
    language: UserLanguage | null;
    traceId?: string;
  }): Promise<void> {
    await this.sendLongTextToChannel({
      guildId: input.guildId,
      channelId: input.channelId,
      traceId: input.traceId,
      content: buildDiscordWorldCreateGuide({
        worldId: input.worldId,
        language: input.language,
      }),
    });
  }

  private async sendCharacterCreateRules(input: {
    guildId?: string;
    channelId: string;
    characterId: number;
    language: UserLanguage | null;
    traceId?: string;
  }): Promise<void> {
    await this.sendLongTextToChannel({
      guildId: input.guildId,
      channelId: input.channelId,
      traceId: input.traceId,
      content: buildDiscordCharacterCreateGuide({
        characterId: input.characterId,
        language: input.language,
      }),
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
    language: UserLanguage | null;
  }): Promise<void> {
    const groupId = buildWorldGroupId(input.worldId);
    const groupPath = await this.groupRepository.ensureGroupDir(groupId);
    const agentPath = path.join(groupPath, "agent.md");
    const content = buildWorldAgentPrompt({
      worldId: input.worldId,
      worldName: input.worldName,
      language: input.language,
    });
    await atomicWrite(agentPath, content);
  }

  private async ensureWorldBuildGroupAgent(input: {
    worldId: number;
    worldName: string;
    language: UserLanguage | null;
  }): Promise<void> {
    const groupId = buildWorldBuildGroupId(input.worldId);
    const groupPath = await this.groupRepository.ensureGroupDir(groupId);
    const agentPath = path.join(groupPath, "agent.md");
    const content = buildWorldBuildAgentPrompt({
      worldId: input.worldId,
      worldName: input.worldName,
      language: input.language,
    });
    await atomicWrite(agentPath, content);
  }

  private async ensureCharacterBuildGroupAgent(input: {
    characterId: number;
    characterName: string;
    language: UserLanguage | null;
  }): Promise<void> {
    const groupId = buildCharacterBuildGroupId(input.characterId);
    const groupPath = await this.groupRepository.ensureGroupDir(groupId);
    const agentPath = path.join(groupPath, "agent.md");
    const content = buildCharacterBuildAgentPrompt({
      characterId: input.characterId,
      characterName: input.characterName,
      language: input.language,
    });
    await atomicWrite(agentPath, content);
  }

  private async ensureWorldCharacterBuildGroupAgent(input: {
    worldId: number;
    worldName: string;
    characterId: number;
    characterName: string;
    language: UserLanguage | null;
  }): Promise<void> {
    const groupId = buildWorldCharacterBuildGroupId({
      worldId: input.worldId,
      characterId: input.characterId,
    });
    const groupPath = await this.groupRepository.ensureGroupDir(groupId);
    const agentPath = path.join(groupPath, "agent.md");
    const content = buildWorldCharacterBuildAgentPrompt({
      worldId: input.worldId,
      worldName: input.worldName,
      characterId: input.characterId,
      characterName: input.characterName,
      language: input.language,
    });
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
    const language = await this.userState
      .getLanguage(input.userId)
      .catch(() => null);
    const content = buildDiscordWorldBuildKickoff({
      worldId: input.worldId,
      worldName: input.worldName,
      language,
    });

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

    const language = await this.userState
      .getLanguage(input.userId)
      .catch(() => null);
    const content = buildDiscordCharacterBuildKickoff({
      characterId: input.characterId,
      characterName: input.characterName,
      language,
    });

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
    const language = await this.userState
      .getLanguage(input.userId)
      .catch(() => null);
    const content = buildDiscordWorldCharacterBuildKickoff({
      worldId: input.worldId,
      worldName: input.worldName,
      characterId: input.characterId,
      characterName: input.characterName,
      language,
    });

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
    const bulletMatch = line.match(
      /^\s*-\s*(创建者|创作者|Creator)\s*[:：]\s*(.+)\s*$/,
    );
    if (bulletMatch) {
      const key = (bulletMatch[1] ?? "").trim();
      const value = (bulletMatch[2] ?? "").trim();
      if (
        !value ||
        value === safeCreatorId ||
        value === `<@${safeCreatorId}>` ||
        /^\d+$/.test(value) ||
        value.includes(safeCreatorId)
      ) {
        lines[i] =
          key === "Creator" ? `- Creator: ${label}` : `- 创建者：${label}`;
        patched = true;
      }
      continue;
    }

    const tableMatch = line.match(
      /^(\s*\|\s*(?:创建者|创作者|Creator)\s*\|\s*)([^|]*?)(\s*\|.*)$/,
    );
    if (!tableMatch) {
      continue;
    }
    const value = (tableMatch[2] ?? "").trim();
    if (
      !value ||
      value === safeCreatorId ||
      value === `<@${safeCreatorId}>` ||
      /^\d+$/.test(value) ||
      value.includes(safeCreatorId)
    ) {
      lines[i] = `${tableMatch[1]}${label}${tableMatch[3]}`;
      patched = true;
    }
  }
  return patched ? lines.join("\n") : input;
}

function isAllowedWikiImportFilename(filename: string): boolean {
  const trimmed = filename.trim().toLowerCase();
  return (
    trimmed.endsWith(".md") ||
    trimmed.endsWith(".markdown") ||
    trimmed.endsWith(".txt")
  );
}

function resolveCanonImportFilename(
  worldId: number,
  rawFilename: string,
): string {
  const trimmed = rawFilename.trim();
  if (!trimmed) {
    return "";
  }
  const prefix = `W${worldId}-`;
  if (trimmed.startsWith(prefix)) {
    return trimmed.slice(prefix.length).trim();
  }
  return trimmed;
}

function buildSlashCommands() {
  return [
    new SlashCommandBuilder()
      .setName("onboard")
      .setDescription("新手引导：选择身份并进入引导话题")
      .addStringOption((option) =>
        option
          .setName("role")
          .setDescription("身份")
          .addChoices(
            { name: "admin", value: "admin" },
            { name: "both", value: "both" },
            { name: "adventurer", value: "adventurer" },
            { name: "world creater", value: "world creater" },
          )
          .setRequired(true),
      )
      .toJSON(),
    new SlashCommandBuilder()
      .setName("language")
      .setDescription("设置 bot 回复语言（影响世界/角色文档写入语言）")
      .addStringOption((option) =>
        option
          .setName("lang")
          .setDescription("语言")
          .addChoices({ name: "zh", value: "zh" }, { name: "en", value: "en" })
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
            "创建世界（进入编辑话题，多轮补全；/world publish 发布）",
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName("open")
          .setDescription("打开该世界的编辑话题（仅创作者）")
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
          .setName("publish")
          .setDescription("发布当前草稿世界（仅创作者，在编辑话题中执行）"),
      )
      .addSubcommand((sub) =>
        sub
          .setName("export")
          .setDescription("导出世界文档（world-card/rules/canon，仅创作者）")
          .addIntegerOption((option) =>
            option
              .setName("world_id")
              .setDescription("世界ID（在世界子空间/编辑话题内可省略）")
              .setMinValue(1)
              .setRequired(false),
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName("import")
          .setDescription(
            "上传并覆盖世界文档（world-card/rules/canon，仅创作者）",
          )
          .addStringOption((option) =>
            option
              .setName("kind")
              .setDescription("类型")
              .addChoices(
                { name: "world_card", value: "world_card" },
                { name: "rules", value: "rules" },
                { name: "canon", value: "canon" },
              )
              .setRequired(true),
          )
          .addAttachmentOption((option) =>
            option
              .setName("file")
              .setDescription("要覆盖的 Markdown/TXT 文件")
              .setRequired(true),
          )
          .addIntegerOption((option) =>
            option
              .setName("world_id")
              .setDescription("世界ID（在世界子空间/编辑话题内可省略）")
              .setMinValue(1)
              .setRequired(false),
          ),
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
          .setDescription("创建角色卡（进入编辑话题，多轮补全）")
          .addStringOption((option) =>
            option
              .setName("name")
              .setDescription("角色名（可选；也可在编辑话题中补全）")
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
          .setDescription("打开该角色的编辑话题（仅创作者）")
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
          .setName("export")
          .setDescription("导出角色卡（仅创作者）")
          .addIntegerOption((option) =>
            option
              .setName("character_id")
              .setDescription("角色ID（在编辑话题中可省略）")
              .setMinValue(1)
              .setRequired(false),
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName("import")
          .setDescription("上传并覆盖角色卡（仅创作者）")
          .addAttachmentOption((option) =>
            option
              .setName("file")
              .setDescription("要覆盖的 Markdown/TXT 文件")
              .setRequired(true),
          )
          .addIntegerOption((option) =>
            option
              .setName("character_id")
              .setDescription("角色ID（在编辑话题中可省略）")
              .setMinValue(1)
              .setRequired(false),
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
              .setDescription("角色ID（可省略：在编辑话题中会取当前角色）")
              .setMinValue(1)
              .setRequired(false),
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName("unpublish")
          .setDescription("将角色设为不公开（private）")
          .addIntegerOption((option) =>
            option
              .setName("character_id")
              .setDescription("角色ID（可省略：在编辑话题中会取当前角色）")
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
          .setDescription("使用公开角色：复制或 fork 为你的角色（默认不公开）")
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

function buildWorldShowcaseOverwrites(input: {
  everyoneRoleId: string;
  botUserId: string;
}): Array<{ id: string; allow?: bigint[]; deny?: bigint[] }> {
  const view = PermissionFlagsBits.ViewChannel;
  const readHistory = PermissionFlagsBits.ReadMessageHistory;
  const send = PermissionFlagsBits.SendMessages;
  const sendInThreads = PermissionFlagsBits.SendMessagesInThreads;
  const useCommands = PermissionFlagsBits.UseApplicationCommands;
  const createPublicThreads = PermissionFlagsBits.CreatePublicThreads;
  const manageThreads = PermissionFlagsBits.ManageThreads;

  return [
    {
      id: input.everyoneRoleId,
      allow: [view, readHistory, sendInThreads, useCommands],
      deny: [send],
    },
    {
      id: input.botUserId,
      allow: [
        view,
        readHistory,
        send,
        sendInThreads,
        createPublicThreads,
        manageThreads,
      ],
    },
  ];
}

function resolveUserLanguageFromDiscordLocale(
  locale: string | null | undefined,
): UserLanguage | null {
  const normalized =
    typeof locale === "string" ? locale.trim().toLowerCase() : "";
  if (normalized.startsWith("zh")) {
    return "zh";
  }
  if (normalized.startsWith("en")) {
    return "en";
  }
  return null;
}

function inferUserLanguageFromText(text: string): UserLanguage | null {
  const normalized = text.trim();
  if (!normalized) {
    return null;
  }
  if (/[\u4e00-\u9fff]/u.test(normalized)) {
    return "zh";
  }
  if (/^[/.]/.test(normalized)) {
    return null;
  }
  if (/[a-zA-Z]{2,}/.test(normalized)) {
    return "en";
  }
  return null;
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
  const manageThreads = PermissionFlagsBits.ManageThreads;

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
              manageThreads,
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

function resolveCharacterCardTemplateLanguage(card: string): "zh" | "en" {
  const head = card.replace(/\r\n/g, "\n").replace(/\r/g, "\n").slice(0, 600);
  if (head.match(/^#\s*Character Card\b/im)) {
    return "en";
  }
  if (head.match(/\bCharacter Card\b/i)) {
    return "en";
  }
  return "zh";
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
  const language = resolveCharacterCardTemplateLanguage(input.sourceCard);
  const header =
    language === "en"
      ? `# Character Card (C${input.forkedCharacterId})`
      : `# 角色卡（C${input.forkedCharacterId}）`;
  return [
    marker,
    header,
    "",
    language === "en"
      ? `- World: W${input.worldId} ${input.worldName}`
      : `- 世界：W${input.worldId} ${input.worldName}`,
    language === "en"
      ? `- Source: forked from C${input.sourceCharacterId}`
      : `- 来源：fork 自 C${input.sourceCharacterId}`,
    language === "en"
      ? `- Creator: ${input.creatorId}`
      : `- 创建者：${input.creatorId}`,
    "",
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
  const language = resolveCharacterCardTemplateLanguage(input.sourceCard);
  const header =
    language === "en"
      ? `# Character Card (C${input.adoptedCharacterId})`
      : `# 角色卡（C${input.adoptedCharacterId}）`;
  return [
    marker,
    header,
    "",
    language === "en"
      ? `- Source: C${input.sourceCharacterId} (${input.mode})`
      : `- 来源：C${input.sourceCharacterId}（${input.mode}）`,
    language === "en"
      ? `- Adopter: ${input.adopterUserId}`
      : `- 采用者：${input.adopterUserId}`,
    "",
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
    if (line.match(/^#\s*角色卡\b/)) {
      lines[i] = `# 角色卡（C${characterId}）`;
      return lines.join("\n");
    }
    if (line.match(/^#\s*Character Card\b/i)) {
      lines[i] = `# Character Card (C${characterId})`;
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
  if (
    idx < lines.length &&
    (lines[idx]?.trim().startsWith("# 角色卡") ||
      lines[idx]?.trim().toLowerCase().startsWith("# character card"))
  ) {
    idx += 1;
    while (idx < lines.length && lines[idx]?.trim() === "") {
      idx += 1;
    }
  }
  return lines.slice(idx).join("\n").trimEnd();
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
    const kindMatch = line.match(/^-\s*(?:类型|Type)\s*[:：]\s*(\w+)\s*$/);
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
    const titleMatch = line.match(/^-\s*(?:标题|Title)\s*[:：]\s*(.+)$/);
    if (titleMatch) {
      title = titleMatch[1]?.trim() || undefined;
      continue;
    }
    const submitterMatch = line.match(
      /^-\s*(?:提交者|Submitter)\s*[:：]\s*<@(\d+)>\s*$/,
    );
    if (submitterMatch) {
      submitterUserId = submitterMatch[1]?.trim() || undefined;
      continue;
    }
    if (line === "## 内容" || line === "## Content") {
      contentStart = i + 1;
      break;
    }
  }

  const body =
    contentStart >= 0 ? lines.slice(contentStart).join("\n").trim() : undefined;

  return { kind, title, submitterUserId, content: body };
}

function buildWorldShowcaseForumOpener(input: {
  worldId: number;
  worldName: string;
  creatorId: string;
  language: UserLanguage | null;
  card: string | null;
}): string {
  const summary = extractWorldOneLiner(input.card);
  const tags = extractWorldCardField(input.card, {
    zh: "类型标签",
    en: "Tags",
  });
  const creator = input.creatorId.trim()
    ? `<@${input.creatorId}>`
    : "(unknown)";
  if (input.language === "en") {
    return [
      `World published: W${input.worldId} ${input.worldName}`,
      summary ? `One-liner: ${summary}` : null,
      tags ? `Tags: ${tags}` : null,
      `Join: /world join world_id:${input.worldId}`,
      `Creator: ${creator}`,
    ]
      .filter((line): line is string => Boolean(line))
      .join("\n");
  }
  return [
    `世界已发布：W${input.worldId} ${input.worldName}`,
    summary ? `一句话：${summary}` : null,
    tags ? `类型标签：${tags}` : null,
    `加入：/world join world_id:${input.worldId}`,
    `创作者：${creator}`,
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n");
}

function buildWorldShowcasePost(input: {
  worldId: number;
  worldName: string;
  creatorId: string;
  language: UserLanguage | null;
  card: string | null;
  rules: string | null;
}): { content: string; embeds: APIEmbed[] } {
  const creator = input.creatorId.trim()
    ? `<@${input.creatorId}>`
    : "(unknown)";
  const summary = extractWorldOneLiner(input.card);
  const tags = extractWorldCardField(input.card, {
    zh: "类型标签",
    en: "Tags",
  });
  const era = extractWorldCardField(input.card, {
    zh: "时代背景",
    en: "Era / Setting",
  });
  const tone = extractWorldCardField(input.card, {
    zh: "整体氛围",
    en: "Overall Tone",
  });
  const core = extractWorldCardField(input.card, {
    zh: "核心元素",
    en: "Core Elements",
  });
  const safeCore = core ? clampText(core, 800) : null;
  const safeRules = input.rules?.trim()
    ? clampText(input.rules.trim(), 1200)
    : "";

  const join = `/world join world_id:${input.worldId}`;
  const embed: APIEmbed = {
    title: `W${input.worldId} ${input.worldName}`,
    description: summary ?? undefined,
    fields: [
      ...(tags
        ? [{ name: input.language === "en" ? "Tags" : "类型标签", value: tags }]
        : []),
      ...(era
        ? [
            {
              name: input.language === "en" ? "Era / Setting" : "时代背景",
              value: era,
            },
          ]
        : []),
      ...(tone
        ? [
            {
              name: input.language === "en" ? "Overall Tone" : "整体氛围",
              value: tone,
            },
          ]
        : []),
      ...(safeCore
        ? [
            {
              name: input.language === "en" ? "Core Elements" : "核心元素",
              value: safeCore,
            },
          ]
        : []),
      { name: input.language === "en" ? "Creator" : "创作者", value: creator },
      { name: input.language === "en" ? "Join" : "加入", value: `\`${join}\`` },
    ],
    footer: {
      text:
        input.language === "en"
          ? "Creator: reply with an image + #cover to set cover."
          : "创作者：回复图片并带 #cover（或“封面”）即可设置封面。",
    },
  };

  const content =
    input.language === "en"
      ? [
          `Creator: ${creator}`,
          `Join: \`${join}\``,
          "Post your onboarding / images in this thread.",
          "Set cover: reply with an image and include `#cover`.",
        ].join("\n")
      : [
          `创作者：${creator}`,
          `加入：\`${join}\``,
          "你可以在本帖继续补充引导/图片/链接。",
          "设置封面：创作者回复图片并带 `#cover`（或“封面”）。",
        ].join("\n");

  const embeds: APIEmbed[] = [embed];
  if (safeRules) {
    embeds.push({
      title:
        input.language === "en" ? "World Rules (Excerpt)" : "世界规则（节选）",
      description: safeRules,
    });
  }
  return { content, embeds };
}

function extractWorldOneLiner(card: string | null): string | null {
  const raw = (card ?? "").trim();
  if (!raw) return null;
  const normalized = raw.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const bulletMatch = normalized.match(
    /^\\s*-\\s*(?:一句话简介|One-line Summary)\\s*[:：]\\s*(.+)\\s*$/m,
  );
  const tableMatch = normalized.match(
    /^\\s*\\|\\s*(?:一句话简介|One-line Summary)\\s*\\|\\s*([^|\\n]+?)\\s*\\|/m,
  );
  const summary = (bulletMatch?.[1] ?? tableMatch?.[1] ?? "").trim();
  if (!summary) return null;
  return summary.length > 80 ? `${summary.slice(0, 80)}…` : summary;
}

function extractWorldCardField(
  card: string | null,
  key: { zh: string; en: string },
): string | null {
  const raw = (card ?? "").trim();
  if (!raw) return null;
  const normalized = raw.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const label = `${escapeRegExp(key.zh)}|${escapeRegExp(key.en)}`;
  const bulletMatch = normalized.match(
    new RegExp(`^\\\\s*-\\\\s*(?:${label})\\\\s*[:：]\\\\s*(.+)\\\\s*$`, "m"),
  );
  const tableMatch = normalized.match(
    new RegExp(
      `^\\\\s*\\\\|\\\\s*(?:${label})\\\\s*\\\\|\\\\s*([^|\\\\n]+?)\\\\s*\\\\|`,
      "m",
    ),
  );
  const value = (bulletMatch?.[1] ?? tableMatch?.[1] ?? "").trim();
  return value ? clampText(value, 200) : null;
}

function clampText(text: string, maxLen: number): string {
  const normalized = text.trim();
  if (!normalized) {
    return "";
  }
  return normalized.length > maxLen
    ? `${normalized.slice(0, maxLen)}…`
    : normalized;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isWorldShowcaseCoverIntent(text: string): boolean {
  const normalized = text.trim();
  if (!normalized) {
    return false;
  }
  if (normalized.includes("封面")) {
    return true;
  }
  return /(^|\s)#cover(\s|$)/i.test(normalized);
}

function pickFirstImageAttachment(
  message: Message,
): { url: string; name?: string } | null {
  if (!message.attachments || message.attachments.size === 0) {
    return null;
  }
  for (const attachment of message.attachments.values()) {
    const contentType = attachment.contentType?.toLowerCase() ?? "";
    const name = attachment.name?.toLowerCase() ?? "";
    if (contentType.startsWith("image/")) {
      return { url: attachment.url, name: attachment.name ?? undefined };
    }
    if (name.match(/\.(png|jpe?g|gif|webp)$/)) {
      return { url: attachment.url, name: attachment.name ?? undefined };
    }
  }
  return null;
}

function extractWorldNameFromCard(card: string | null): string | null {
  const raw = (card ?? "").trim();
  if (!raw) return null;
  const normalized = raw.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const bulletMatch = normalized.match(
    /^\\s*-\\s*(?:世界名称|World Name)\\s*[:：]\\s*(.+)\\s*$/m,
  );
  const tableMatch = normalized.match(
    /^\\s*\\|\\s*(?:世界名称|World Name)\\s*\\|\\s*([^|\\n]+?)\\s*\\|/m,
  );
  const headingMatch = normalized.match(
    /^\\s*#\\s*(?:世界卡|世界观设计卡)\\s*[:：]\\s*(.+)\\s*$/m,
  );
  const name = (
    bulletMatch?.[1] ??
    tableMatch?.[1] ??
    headingMatch?.[1] ??
    ""
  ).trim();
  if (!name) return null;
  return name.length > 60 ? name.slice(0, 60) : name;
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
  } catch (err) {
    feishuLogJson({
      event: "log.warn",
      msg: "Failed to reply discord interaction",
      errName: err instanceof Error ? err.name : "Error",
      errMessage: err instanceof Error ? err.message : String(err),
      command: buildInteractionCommand(interaction),
      interactionId: interaction.id,
      userId: interaction.user.id,
      guildId: interaction.guildId ?? undefined,
      channelId: interaction.channelId,
      ephemeral: options.ephemeral,
    });
  }
}

async function tryEditInteractionReply(
  interaction: ChatInputCommandInteraction,
  content: string,
  options: { ephemeral: boolean },
): Promise<boolean> {
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
      await interaction.editReply({ content });
      return true;
    }
    await interaction.reply({ content, ephemeral: options.ephemeral });
    return true;
  } catch (err) {
    feishuLogJson({
      event: "log.warn",
      msg: "Failed to edit discord interaction reply",
      errName: err instanceof Error ? err.name : "Error",
      errMessage: err instanceof Error ? err.message : String(err),
      command: buildInteractionCommand(interaction),
      interactionId: interaction.id,
      userId: interaction.user.id,
      guildId: interaction.guildId ?? undefined,
      channelId: interaction.channelId,
      ephemeral: options.ephemeral,
    });
    return false;
  }
}

async function safeReplyRich(
  interaction: ChatInputCommandInteraction,
  payload: {
    content?: string;
    embeds?: APIEmbed[];
    files?: Array<{ attachment: Buffer; name: string }>;
  },
  options: { ephemeral: boolean },
): Promise<void> {
  const safePayload = {
    content: payload.content?.trim() ?? undefined,
    embeds: payload.embeds ?? undefined,
    files: payload.files ?? undefined,
  };
  if (
    !safePayload.content &&
    (!safePayload.embeds || safePayload.embeds.length === 0) &&
    (!safePayload.files || safePayload.files.length === 0)
  ) {
    return;
  }

  feishuLogJson({
    event: "discord.command.reply",
    command: buildInteractionCommand(interaction),
    interactionId: interaction.id,
    userId: interaction.user.id,
    guildId: interaction.guildId ?? undefined,
    channelId: interaction.channelId,
    ephemeral: options.ephemeral,
    contentPreview: previewTextForLog(safePayload.content ?? "", 1200),
    contentLength: safePayload.content?.length ?? 0,
    hasFiles: Boolean(safePayload.files && safePayload.files.length > 0),
    hasEmbeds: Boolean(safePayload.embeds && safePayload.embeds.length > 0),
  });

  try {
    if (interaction.replied) {
      await interaction.followUp({
        ...safePayload,
        ephemeral: options.ephemeral,
      });
      return;
    }
    if (interaction.deferred) {
      await interaction.editReply(safePayload);
      return;
    }
    await interaction.reply({ ...safePayload, ephemeral: options.ephemeral });
  } catch (err) {
    feishuLogJson({
      event: "log.warn",
      msg: "Failed to reply discord interaction",
      errName: err instanceof Error ? err.name : "Error",
      errMessage: err instanceof Error ? err.message : String(err),
      command: buildInteractionCommand(interaction),
      interactionId: interaction.id,
      userId: interaction.user.id,
      guildId: interaction.guildId ?? undefined,
      channelId: interaction.channelId,
      ephemeral: options.ephemeral,
    });
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
  } catch (err) {
    feishuLogJson({
      event: "log.warn",
      msg: "Failed to defer discord interaction",
      errName: err instanceof Error ? err.name : "Error",
      errMessage: err instanceof Error ? err.message : String(err),
      command: buildInteractionCommand(interaction),
      interactionId: interaction.id,
      userId: interaction.user.id,
      guildId: interaction.guildId ?? undefined,
      channelId: interaction.channelId,
      ephemeral: options.ephemeral,
    });
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
