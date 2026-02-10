import { EventEmitter } from "node:events";
import type { Logger } from "pino";
import {
  Client,
  GatewayIntentBits,
  Partials,
  APIEmbed,
  ChatInputCommandInteraction,
  GuildMember,
  PartialGuildMember,
  Message,
  MessageCreateOptions,
} from "discord.js";
import type {
  Bot,
  MessageHandler,
  PlatformAdapter,
  SendMessageOptions,
  SessionEvent,
} from "../../types/platform";
import { logger as defaultLogger } from "../../logger";
import { parseMessage, DiscordMessageExtras } from "./parser";
import { MessageSender } from "./sender";
import {
  buildDiscordOnboardingIdentityRoleConfig,
  resolveDiscordIdentityRoles,
} from "./onboarding-identity";
import type { BotMessageStore } from "../../store/bot-message-store";
import { WorldStore, CharacterVisibility } from "../../world/store";
import { WorldFileStore } from "../../world/file-store";
import { buildWorldBuildGroupId, parseWorldGroup } from "../../world/ids";
import { parseCharacterGroup } from "../../character/ids";
import { getConfig } from "../../config";

import { GroupFileRepository } from "../../store/repository";
import {
  DEFAULT_DISCORD_TEXT_ATTACHMENT_MAX_BYTES,
  fetchDiscordTextAttachment,
} from "./text-attachments";

import {
  isWorldShowcaseCoverIntent,
  pickFirstImageAttachment,
} from "./card-parsers";

import {
  safeComponentFollowUp,
  safeDeferUpdate,
  safeReply,
  tryEditInteractionReply,
} from "./interaction-helpers";
import { buildWorldShowcasePost } from "./world-showcase-builders";

import {
  inferUserLanguageFromText,
  resolveUserLanguageFromDiscordLocale,
} from "./language-helpers";

import { resolveUserMessageFromError } from "./adapter-internals";
import { installDiscordAdapterInteractionOnboarding } from "./adapter-interaction-onboarding";
import { installDiscordAdapterOnboardingWorldEntry } from "./adapter-onboarding-world-entry";
import { installDiscordAdapterWorldLifecycle } from "./adapter-world-lifecycle";
import { installDiscordAdapterWorldCharacterEntry } from "./adapter-world-character-entry";
import { installDiscordAdapterCharacterSubspace } from "./adapter-character-subspace";
import { installDiscordAdapterShowcaseBootstrap } from "./adapter-showcase-bootstrap";

import { extractTextFromJsonDocument } from "../../utils/json-text";

import { UserStateStore, UserRole } from "../../user/state-store";

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
        const language = await this.userState
          .getLanguage(interaction.user.id)
          .catch(() => null);
        const message = resolveUserMessageFromError(language, err, {
          zh: "处理失败，请稍后重试。",
          en: "Failed. Please try again.",
        });
        if (interaction.isChatInputCommand()) {
          await safeReply(interaction, message, { ephemeral: true });
          return;
        }
        if (interaction.isMessageComponent()) {
          await safeDeferUpdate(interaction);
          await safeComponentFollowUp(interaction, message, {
            ephemeral: true,
          });
        }
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
      await this.sendOnboardingMenu({
        guildId: member.guild.id,
        channelId: threadId,
        userId: member.id,
        role,
        language,
      });
      created.push({ role, channelId: threadId });
    }

    if (created.length === 0) {
      return;
    }

    const roleLabel = (role: UserRole) =>
      role === "world creater"
        ? "world creater / 世界创建者"
        : "adventurer / 冒险者";
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
    const worldIdFromParent =
      await this.worldStore.getWorldIdByChannel(parentId);
    const worldIdFromCategory =
      worldIdFromParent ??
      (await this.worldStore.getWorldIdByCategory(parentId));
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
    await this.userState
      .addRoles(message.author.id, ["adventurer"])
      .catch(() => {
        // ignore
      });
    await this.sendOnboardingMenu({
      guildId: message.guildId,
      channelId: threadId,
      userId: message.author.id,
      role: "adventurer",
      language: existing?.language ?? null,
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
        `已读取并收录到「世界书：原始资料」（${uploaded.length} 个文档）。以下文件被忽略：\n${ignoredLines.map((line) => `- ${line}`).join("\n")}`,
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
        `已读取并收录到「角色图书馆：原始资料」（${uploaded.length} 个文档）。以下文件被忽略：\n${ignoredLines.map((line) => `- ${line}`).join("\n")}`,
      );
    } else if (!session.content?.trim()) {
      await this.sendMessage(
        session,
        `已读取并收录到「角色图书馆：原始资料」（${uploaded.length} 个文档）。`,
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

  private async handleInteraction(..._args: unknown[]): Promise<void> {
    throw new Error("Method not installed: handleInteraction");
  }

  private async handleButtonInteraction(..._args: unknown[]): Promise<void> {
    throw new Error("Method not installed: handleButtonInteraction");
  }

  private async handleStringSelectMenuInteraction(
    ..._args: unknown[]
  ): Promise<void> {
    throw new Error("Method not installed: handleStringSelectMenuInteraction");
  }

  private async handleOnboard(..._args: unknown[]): Promise<void> {
    throw new Error("Method not installed: handleOnboard");
  }

  private async handleOnboardingComponentAction(
    ..._args: unknown[]
  ): Promise<void> {
    throw new Error("Method not installed: handleOnboardingComponentAction");
  }

  private async inferOnboardingRoleForChannel(
    ..._args: unknown[]
  ): Promise<UserRole | null> {
    throw new Error("Method not installed: inferOnboardingRoleForChannel");
  }

  private async sendOnboardingMenu(..._args: unknown[]): Promise<void> {
    throw new Error("Method not installed: sendOnboardingMenu");
  }

  private buildOnboardingMenuComponents(
    ..._args: unknown[]
  ): MessageCreateOptions["components"] {
    throw new Error("Method not installed: buildOnboardingMenuComponents");
  }

  private async sendOnboardingAfterCharacterCreate(
    ..._args: unknown[]
  ): Promise<void> {
    throw new Error("Method not installed: sendOnboardingAfterCharacterCreate");
  }

  private async sendCharacterCardToChannel(..._args: unknown[]): Promise<void> {
    throw new Error("Method not installed: sendCharacterCardToChannel");
  }

  private async sendWorldCardToChannel(..._args: unknown[]): Promise<void> {
    throw new Error("Method not installed: sendWorldCardToChannel");
  }

  private async sendOnboardingWorldJoinCharacterPicker(
    ..._args: unknown[]
  ): Promise<void> {
    throw new Error(
      "Method not installed: sendOnboardingWorldJoinCharacterPicker",
    );
  }

  private async sendOnboardingWorldList(..._args: unknown[]): Promise<void> {
    throw new Error("Method not installed: sendOnboardingWorldList");
  }

  private async handleOnboardingWorldJoin(..._args: unknown[]): Promise<void> {
    throw new Error("Method not installed: handleOnboardingWorldJoin");
  }

  private async sendOnboardingAfterWorldJoin(
    ..._args: unknown[]
  ): Promise<void> {
    throw new Error("Method not installed: sendOnboardingAfterWorldJoin");
  }

  private async sendOnboardingAfterWorldCreate(
    ..._args: unknown[]
  ): Promise<void> {
    throw new Error("Method not installed: sendOnboardingAfterWorldCreate");
  }

  private rememberPendingInteractionReply(..._args: unknown[]): void {
    throw new Error("Method not installed: rememberPendingInteractionReply");
  }

  private takePendingInteractionReply(
    ..._args: unknown[]
  ): ChatInputCommandInteraction | null {
    throw new Error("Method not installed: takePendingInteractionReply");
  }

  private async handleLanguage(..._args: unknown[]): Promise<void> {
    throw new Error("Method not installed: handleLanguage");
  }

  private async handleWorldCommand(..._args: unknown[]): Promise<void> {
    throw new Error("Method not installed: handleWorldCommand");
  }

  private async handleWorldCreate(..._args: unknown[]): Promise<void> {
    throw new Error("Method not installed: handleWorldCreate");
  }

  private async createWorldDraftAndThread(..._args: unknown[]): Promise<{
    worldId: number;
    worldName: string;
    buildConversationChannelId: string;
  }> {
    throw new Error("Method not installed: createWorldDraftAndThread");
  }

  private async handleWorldHelp(..._args: unknown[]): Promise<void> {
    throw new Error("Method not installed: handleWorldHelp");
  }

  private async handleWorldExport(..._args: unknown[]): Promise<void> {
    throw new Error("Method not installed: handleWorldExport");
  }

  private async handleWorldImport(..._args: unknown[]): Promise<void> {
    throw new Error("Method not installed: handleWorldImport");
  }

  private async handleWorldImageUpload(..._args: unknown[]): Promise<void> {
    throw new Error("Method not installed: handleWorldImageUpload");
  }

  private async handleWorldOpen(..._args: unknown[]): Promise<void> {
    throw new Error("Method not installed: handleWorldOpen");
  }

  private async resolveWorldBuildDraftFromChannel(..._args: unknown[]): Promise<
    | {
        ok: true;
        worldId: number;
        meta: NonNullable<Awaited<ReturnType<WorldStore["getWorld"]>>>;
      }
    | { ok: false; message: string }
  > {
    throw new Error("Method not installed: resolveWorldBuildDraftFromChannel");
  }

  private async resolveCharacterBuildDraftFromChannel(
    ..._args: unknown[]
  ): Promise<
    | {
        ok: true;
        characterId: number;
        meta: NonNullable<Awaited<ReturnType<WorldStore["getCharacter"]>>>;
      }
    | { ok: false; message: string }
  > {
    throw new Error(
      "Method not installed: resolveCharacterBuildDraftFromChannel",
    );
  }

  private async publishWorldFromBuildChannel(
    ..._args: unknown[]
  ): Promise<string> {
    throw new Error("Method not installed: publishWorldFromBuildChannel");
  }

  private async publishWorldFunctionalGuides(
    ..._args: unknown[]
  ): Promise<void> {
    throw new Error("Method not installed: publishWorldFunctionalGuides");
  }

  private async handleWorldPublish(..._args: unknown[]): Promise<void> {
    throw new Error("Method not installed: handleWorldPublish");
  }

  private async handleWorldList(..._args: unknown[]): Promise<void> {
    throw new Error("Method not installed: handleWorldList");
  }

  private async handleWorldInfo(..._args: unknown[]): Promise<void> {
    throw new Error("Method not installed: handleWorldInfo");
  }

  private async handleWorldRules(..._args: unknown[]): Promise<void> {
    throw new Error("Method not installed: handleWorldRules");
  }

  private async handleWorldCanon(..._args: unknown[]): Promise<void> {
    throw new Error("Method not installed: handleWorldCanon");
  }

  private async handleWorldSubmit(..._args: unknown[]): Promise<void> {
    throw new Error("Method not installed: handleWorldSubmit");
  }

  private async handleWorldApprove(..._args: unknown[]): Promise<void> {
    throw new Error("Method not installed: handleWorldApprove");
  }

  private async handleWorldCheck(..._args: unknown[]): Promise<void> {
    throw new Error("Method not installed: handleWorldCheck");
  }

  private async handleWorldJoin(..._args: unknown[]): Promise<void> {
    throw new Error("Method not installed: handleWorldJoin");
  }

  private async joinWorldForUser(..._args: unknown[]): Promise<{
    worldId: number;
    worldName: string;
    roleplayChannelId: string;
    forumChannelId?: string;
    characterId: number;
    characterName: string;
    forked: boolean;
    sourceCharacterId: number;
  }> {
    throw new Error("Method not installed: joinWorldForUser");
  }

  private async handleWorldStats(..._args: unknown[]): Promise<void> {
    throw new Error("Method not installed: handleWorldStats");
  }

  private async handleWorldSearch(..._args: unknown[]): Promise<void> {
    throw new Error("Method not installed: handleWorldSearch");
  }

  private async handleWorldEdit(..._args: unknown[]): Promise<void> {
    throw new Error("Method not installed: handleWorldEdit");
  }

  private async handleWorldDone(..._args: unknown[]): Promise<void> {
    throw new Error("Method not installed: handleWorldDone");
  }

  private async handleWorldRemove(..._args: unknown[]): Promise<void> {
    throw new Error("Method not installed: handleWorldRemove");
  }

  private async handleCharacterCommand(..._args: unknown[]): Promise<void> {
    throw new Error("Method not installed: handleCharacterCommand");
  }

  private async handleCharacterCreate(..._args: unknown[]): Promise<void> {
    throw new Error("Method not installed: handleCharacterCreate");
  }

  private async createCharacterDraftAndThread(..._args: unknown[]): Promise<{
    characterId: number;
    characterName: string;
    visibility: CharacterVisibility;
    buildConversationChannelId: string;
    threadCreated: boolean;
  }> {
    throw new Error("Method not installed: createCharacterDraftAndThread");
  }

  private async handleCharacterHelp(..._args: unknown[]): Promise<void> {
    throw new Error("Method not installed: handleCharacterHelp");
  }

  private async handleCharacterExport(..._args: unknown[]): Promise<void> {
    throw new Error("Method not installed: handleCharacterExport");
  }

  private async handleCharacterImport(..._args: unknown[]): Promise<void> {
    throw new Error("Method not installed: handleCharacterImport");
  }

  private async handleCharacterView(..._args: unknown[]): Promise<void> {
    throw new Error("Method not installed: handleCharacterView");
  }

  private async handleCharacterAct(..._args: unknown[]): Promise<void> {
    throw new Error("Method not installed: handleCharacterAct");
  }

  private async handleCharacterOpen(..._args: unknown[]): Promise<void> {
    throw new Error("Method not installed: handleCharacterOpen");
  }

  private async handleCharacterUse(..._args: unknown[]): Promise<void> {
    throw new Error("Method not installed: handleCharacterUse");
  }

  private async handleCharacterPublish(..._args: unknown[]): Promise<void> {
    throw new Error("Method not installed: handleCharacterPublish");
  }

  private async publishCharacterShowcasePost(
    ..._args: unknown[]
  ): Promise<void> {
    throw new Error("Method not installed: publishCharacterShowcasePost");
  }

  private async ensureCharacterShowcaseChannel(
    ..._args: unknown[]
  ): Promise<{ channelId: string; mode: "forum" | "text" }> {
    throw new Error("Method not installed: ensureCharacterShowcaseChannel");
  }

  private async handleCharacterUnpublish(..._args: unknown[]): Promise<void> {
    throw new Error("Method not installed: handleCharacterUnpublish");
  }

  private async handleCharacterList(..._args: unknown[]): Promise<void> {
    throw new Error("Method not installed: handleCharacterList");
  }

  private async handleCharacterSearch(..._args: unknown[]): Promise<void> {
    throw new Error("Method not installed: handleCharacterSearch");
  }

  private async handleCharacterAdopt(..._args: unknown[]): Promise<void> {
    throw new Error("Method not installed: handleCharacterAdopt");
  }

  private async resolveCharacterIdForVisibilityCommand(
    ..._args: unknown[]
  ): Promise<number> {
    throw new Error(
      "Method not installed: resolveCharacterIdForVisibilityCommand",
    );
  }

  private async resolveCharacterIdFromInteraction(
    ..._args: unknown[]
  ): Promise<number> {
    throw new Error("Method not installed: resolveCharacterIdFromInteraction");
  }

  private async resolveJoinCharacterId(..._args: unknown[]): Promise<number> {
    throw new Error("Method not installed: resolveJoinCharacterId");
  }

  private async ensureWorldSpecificCharacter(..._args: unknown[]): Promise<{
    characterId: number;
    sourceCharacterId: number;
    forked: boolean;
  }> {
    throw new Error("Method not installed: ensureWorldSpecificCharacter");
  }

  private async maybeStartWorldCharacterAutoFix(
    ..._args: unknown[]
  ): Promise<void> {
    throw new Error("Method not installed: maybeStartWorldCharacterAutoFix");
  }

  private async handleCharacterClose(..._args: unknown[]): Promise<void> {
    throw new Error("Method not installed: handleCharacterClose");
  }

  private async tryCreatePrivateThread(
    ..._args: unknown[]
  ): Promise<{ threadId: string; parentChannelId: string } | null> {
    throw new Error("Method not installed: tryCreatePrivateThread");
  }

  private async reopenPrivateThreadForUser(..._args: unknown[]): Promise<void> {
    throw new Error("Method not installed: reopenPrivateThreadForUser");
  }

  private async createCreatorOnlyChannel(
    ..._args: unknown[]
  ): Promise<{ id: string }> {
    throw new Error("Method not installed: createCreatorOnlyChannel");
  }

  private async ensureOnboardingThread(..._args: unknown[]): Promise<string> {
    throw new Error("Method not installed: ensureOnboardingThread");
  }

  private async migrateWorldAgents(..._args: unknown[]): Promise<void> {
    throw new Error("Method not installed: migrateWorldAgents");
  }

  private async inferWorldIdFromWorldSubspace(
    ..._args: unknown[]
  ): Promise<number | null> {
    throw new Error("Method not installed: inferWorldIdFromWorldSubspace");
  }

  private async resolveBaseChannelId(
    ..._args: unknown[]
  ): Promise<string | null> {
    throw new Error("Method not installed: resolveBaseChannelId");
  }

  private async sendLongTextToChannel(..._args: unknown[]): Promise<void> {
    throw new Error("Method not installed: sendLongTextToChannel");
  }

  private async sendRichToChannel(..._args: unknown[]): Promise<void> {
    throw new Error("Method not installed: sendRichToChannel");
  }

  private async pushWorldInfoSnapshot(..._args: unknown[]): Promise<void> {
    throw new Error("Method not installed: pushWorldInfoSnapshot");
  }

  private async createWorldSubspace(..._args: unknown[]): Promise<{
    roleId: string;
    categoryId: string;
    infoChannelId: string;
    discussionChannelId: string;
    forumChannelId: string;
    proposalsChannelId: string;
    voiceChannelId: string;
  }> {
    throw new Error("Method not installed: createWorldSubspace");
  }

  private async publishWorldShowcasePost(
    ..._args: unknown[]
  ): Promise<{ status: "created" | "exists"; channelId: string }> {
    throw new Error("Method not installed: publishWorldShowcasePost");
  }

  private async ensureWorldShowcaseChannel(
    ..._args: unknown[]
  ): Promise<{ channelId: string; mode: "forum" | "text" }> {
    throw new Error("Method not installed: ensureWorldShowcaseChannel");
  }

  private async ensureWorldShowcaseForumTags(
    ..._args: unknown[]
  ): Promise<void> {
    throw new Error("Method not installed: ensureWorldShowcaseForumTags");
  }

  private async sendRichToChannelAndGetId(
    ..._args: unknown[]
  ): Promise<string | null> {
    throw new Error("Method not installed: sendRichToChannelAndGetId");
  }

  private async sendWorldCreateRules(..._args: unknown[]): Promise<void> {
    throw new Error("Method not installed: sendWorldCreateRules");
  }

  private async sendCharacterCreateRules(..._args: unknown[]): Promise<void> {
    throw new Error("Method not installed: sendCharacterCreateRules");
  }

  private async migrateWorldSubspaceChannels(
    ..._args: unknown[]
  ): Promise<void> {
    throw new Error("Method not installed: migrateWorldSubspaceChannels");
  }

  private async ensureWorldGroupAgent(..._args: unknown[]): Promise<void> {
    throw new Error("Method not installed: ensureWorldGroupAgent");
  }

  private async ensureWorldBuildGroupAgent(..._args: unknown[]): Promise<void> {
    throw new Error("Method not installed: ensureWorldBuildGroupAgent");
  }

  private async ensureCharacterBuildGroupAgent(
    ..._args: unknown[]
  ): Promise<void> {
    throw new Error("Method not installed: ensureCharacterBuildGroupAgent");
  }

  private async ensureWorldCharacterBuildGroupAgent(
    ..._args: unknown[]
  ): Promise<void> {
    throw new Error(
      "Method not installed: ensureWorldCharacterBuildGroupAgent",
    );
  }

  private async emitSyntheticWorldBuildKickoff(
    ..._args: unknown[]
  ): Promise<void> {
    throw new Error("Method not installed: emitSyntheticWorldBuildKickoff");
  }

  private async emitSyntheticWorldBuildAutopilot(
    ..._args: unknown[]
  ): Promise<void> {
    throw new Error("Method not installed: emitSyntheticWorldBuildAutopilot");
  }

  private async emitSyntheticCharacterBuildKickoff(
    ..._args: unknown[]
  ): Promise<void> {
    throw new Error("Method not installed: emitSyntheticCharacterBuildKickoff");
  }

  private async emitSyntheticCharacterBuildAutopilot(
    ..._args: unknown[]
  ): Promise<void> {
    throw new Error(
      "Method not installed: emitSyntheticCharacterBuildAutopilot",
    );
  }

  private async emitSyntheticCharacterPortraitGenerate(
    ..._args: unknown[]
  ): Promise<void> {
    throw new Error(
      "Method not installed: emitSyntheticCharacterPortraitGenerate",
    );
  }

  private async emitSyntheticWorldCharacterBuildKickoff(
    ..._args: unknown[]
  ): Promise<void> {
    throw new Error(
      "Method not installed: emitSyntheticWorldCharacterBuildKickoff",
    );
  }

  private async resolveDiscordUserLabel(..._args: unknown[]): Promise<string> {
    throw new Error("Method not installed: resolveDiscordUserLabel");
  }

  private async registerSlashCommands(..._args: unknown[]): Promise<void> {
    throw new Error("Method not installed: registerSlashCommands");
  }
}
installDiscordAdapterInteractionOnboarding(DiscordAdapter);
installDiscordAdapterOnboardingWorldEntry(DiscordAdapter);
installDiscordAdapterWorldLifecycle(DiscordAdapter);
installDiscordAdapterWorldCharacterEntry(DiscordAdapter);
installDiscordAdapterCharacterSubspace(DiscordAdapter);
installDiscordAdapterShowcaseBootstrap(DiscordAdapter);
