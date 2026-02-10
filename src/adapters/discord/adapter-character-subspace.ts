import type { DiscordAdapter } from "./adapter";
import {
  buildWorldCharacterBuildGroupId,
  parseCharacterGroup,
} from "../../character/ids";
import { getConfig } from "../../config";
import { feishuLogJson } from "../../feishu/webhook";
import type { SessionEvent } from "../../types/platform";
import type { UserLanguage, UserRole } from "../../user/state-store";
import { pickByLanguage } from "./adapter-internals";
import { splitDiscordMessage } from "./card-parsers";
import {
  buildAdoptedCharacterCard,
  buildWorldForkedCharacterCard,
  hasWorldForkMarker,
  patchCreatorLineInMarkdown,
} from "./character-card-variants";
import { previewTextForLog, safeReply } from "./interaction-helpers";
import {
  buildMarkdownCardEmbeds,
  chunkEmbedsForDiscord,
} from "./markdown-cards";
import {
  buildDraftCreatorOnlyOverwrites,
  buildWorldBaseOverwrites,
  buildWorldShowcaseOverwrites,
} from "./permission-overwrites";
import { DEFAULT_DISCORD_TEXT_ATTACHMENT_MAX_BYTES } from "./text-attachments";
import { buildWorldWikiLinks } from "./url-helpers";
import { buildCharacterShowcaseThreadContent } from "./world-showcase-builders";
import {
  type APIEmbed,
  ChannelType,
  ChatInputCommandInteraction,
  Guild,
  MessageCreateOptions,
} from "discord.js";

export function installDiscordAdapterCharacterSubspace(DiscordAdapterClass: {
  prototype: DiscordAdapter;
}): void {
  (
    DiscordAdapterClass.prototype as unknown as Record<string, unknown>
  ).handleCharacterUse = async function (
    this: DiscordAdapter,
    interaction: ChatInputCommandInteraction,
    characterId: number,
  ): Promise<void> {
    const language = await this["userState"]
      .getLanguage(interaction.user.id)
      .catch(() => null);
    const meta = await this["worldStore"].getCharacter(characterId);
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
    await this["worldStore"].setGlobalActiveCharacter({
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
  };

  (
    DiscordAdapterClass.prototype as unknown as Record<string, unknown>
  ).handleCharacterPublish = async function (
    this: DiscordAdapter,
    interaction: ChatInputCommandInteraction,
    characterId?: number,
  ): Promise<void> {
    let resolved: number;
    try {
      resolved = await this["resolveCharacterIdForVisibilityCommand"](
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
    const meta = await this["worldStore"].getCharacter(resolved);
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
    await this["worldStore"].setCharacterVisibility({
      characterId: meta.id,
      visibility: "public",
    });

    if (interaction.guildId && interaction.guild) {
      void this["publishCharacterShowcasePost"]({
        guild: interaction.guild,
        guildId: interaction.guildId,
        characterId: meta.id,
        characterName: meta.name,
        creatorId: meta.creatorId,
      }).catch((err) => {
        this["logger"].warn(
          { err, characterId: meta.id, guildId: interaction.guildId },
          "Failed to publish character showcase post",
        );
      });
    }

    await safeReply(interaction, `已公开角色：C${meta.id} ${meta.name}`, {
      ephemeral: true,
    });
  };

  (
    DiscordAdapterClass.prototype as unknown as Record<string, unknown>
  ).publishCharacterShowcasePost = async function (
    this: DiscordAdapter,
    input: {
      guild: Guild;
      guildId: string;
      characterId: number;
      characterName: string;
      creatorId: string;
    },
  ): Promise<void> {
    const existing = await this["worldStore"].getCharacterShowcasePost(
      input.characterId,
    );
    if (existing) {
      return;
    }

    const botUserId = this["botUserId"] ?? this["client"].user?.id ?? "";
    if (!botUserId) {
      return;
    }

    const gallery = await this["ensureCharacterShowcaseChannel"]({
      guild: input.guild,
      botUserId,
      reason: `character showcase ensure for C${input.characterId}`,
    });
    const channel = await input.guild.channels
      .fetch(gallery.channelId)
      .catch(() => null);
    if (!channel) {
      return;
    }

    const card = await this["worldFiles"].readCharacterCard(input.characterId);
    const threadName = `C${input.characterId} ${input.characterName}`.slice(
      0,
      100,
    );
    const reason = `character publish C${input.characterId}`;
    const content = buildCharacterShowcaseThreadContent({
      characterId: input.characterId,
      characterName: input.characterName,
      creatorId: input.creatorId,
      card,
    });

    let threadId: string | null = null;
    let messageId: string | null = null;
    if (gallery.mode === "forum") {
      const created = await (
        channel as unknown as {
          threads?: {
            create?: (input: Record<string, unknown>) => Promise<{
              id: string;
              fetchStarterMessage?: () => Promise<{ id: string }>;
            }>;
          };
        }
      ).threads?.create?.({
        name: threadName,
        message: { content },
        reason,
      });
      if (created) {
        threadId = created.id;
        if (typeof created.fetchStarterMessage === "function") {
          const starter = await created.fetchStarterMessage().catch(() => null);
          const starterId = starter?.id?.trim() ?? "";
          if (starterId) {
            messageId = starterId;
          }
        }
      }
    } else {
      const created = await (
        channel as unknown as {
          threads?: {
            create?: (
              input: Record<string, unknown>,
            ) => Promise<{ id: string }>;
          };
        }
      ).threads?.create?.({
        name: threadName,
        type: ChannelType.PublicThread,
        autoArchiveDuration: 10080,
        reason,
      });
      if (created) {
        threadId = created.id;
      }
    }
    if (!threadId) {
      return;
    }

    if (!messageId) {
      messageId = await this["sendRichToChannelAndGetId"]({
        channelId: threadId,
        content,
      });
    }
    if (!messageId) {
      return;
    }

    await this["worldStore"].setCharacterShowcasePost({
      characterId: input.characterId,
      channelId: gallery.channelId,
      threadId,
      messageId,
    });
  };

  (
    DiscordAdapterClass.prototype as unknown as Record<string, unknown>
  ).ensureCharacterShowcaseChannel = async function (
    this: DiscordAdapter,
    input: {
      guild: Guild;
      botUserId: string;
      reason: string;
    },
  ): Promise<{ channelId: string; mode: "forum" | "text" }> {
    const channelName = "character-gallery";
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
      this["logger"].warn(
        { err },
        "Failed to create character forum channel; fallback to text",
      );
    }

    const text = await input.guild.channels.create({
      name: channelName,
      type: ChannelType.GuildText,
      permissionOverwrites: overwrites,
      reason: input.reason,
    });
    return { channelId: text.id, mode: "text" };
  };

  (
    DiscordAdapterClass.prototype as unknown as Record<string, unknown>
  ).handleCharacterUnpublish = async function (
    this: DiscordAdapter,
    interaction: ChatInputCommandInteraction,
    characterId?: number,
  ): Promise<void> {
    let resolved: number;
    try {
      resolved = await this["resolveCharacterIdForVisibilityCommand"](
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
    const meta = await this["worldStore"].getCharacter(resolved);
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
    await this["worldStore"].setCharacterVisibility({
      characterId: meta.id,
      visibility: "private",
    });
    await safeReply(interaction, `已设为不公开：C${meta.id} ${meta.name}`, {
      ephemeral: true,
    });
  };

  (
    DiscordAdapterClass.prototype as unknown as Record<string, unknown>
  ).handleCharacterList = async function (
    this: DiscordAdapter,
    interaction: ChatInputCommandInteraction,
    input: { limit?: number },
  ): Promise<void> {
    const limit = Math.max(1, Math.min(100, Math.floor(input.limit ?? 20)));
    const ids = await this["worldStore"].listUserCharacterIds(
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
      ids.map((id) => this["worldStore"].getCharacter(id)),
    );
    const lines = metas
      .filter((meta): meta is NonNullable<typeof meta> => Boolean(meta))
      .map(
        (meta) => `C${meta.id} ${meta.name}（visibility=${meta.visibility}）`,
      );
    await safeReply(interaction, lines.join("\n"), { ephemeral: true });
  };

  (
    DiscordAdapterClass.prototype as unknown as Record<string, unknown>
  ).handleCharacterSearch = async function (
    this: DiscordAdapter,
    interaction: ChatInputCommandInteraction,
    input: { query: string; limit?: number },
  ): Promise<void> {
    const query = input.query.trim();
    if (!query) {
      await safeReply(interaction, "query 不能为空。", { ephemeral: true });
      return;
    }
    const limit = Math.max(1, Math.min(50, Math.floor(input.limit ?? 10)));
    const ids = await this["worldStore"].listPublicCharacterIds(200);
    const lowered = query.toLowerCase();
    const numeric = Number(query);
    const results: string[] = [];
    for (const id of ids) {
      if (results.length >= limit) {
        break;
      }
      const meta = await this["worldStore"].getCharacter(id);
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
  };

  (
    DiscordAdapterClass.prototype as unknown as Record<string, unknown>
  ).handleCharacterAdopt = async function (
    this: DiscordAdapter,
    interaction: ChatInputCommandInteraction,
    input: { characterId: number; mode: "copy" | "fork" },
  ): Promise<void> {
    const sourceMeta = await this["worldStore"].getCharacter(input.characterId);
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
    const sourceCard = await this["worldFiles"].readCharacterCard(
      sourceMeta.id,
    );
    if (!sourceCard) {
      await safeReply(interaction, "角色卡缺失（待修复）。", {
        ephemeral: true,
      });
      return;
    }

    const characterId = await this["worldStore"].nextCharacterId();
    const nowIso = new Date().toISOString();
    const name = sourceMeta.name.trim() || `Character-${characterId}`;
    await this["worldStore"].createCharacter({
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
    await this["worldFiles"].writeCharacterCard(characterId, adoptedCard);
    await this["worldFiles"].appendCharacterEvent(characterId, {
      type: "character_adopted",
      characterId,
      userId: interaction.user.id,
      mode: input.mode,
      sourceCharacterId: sourceMeta.id,
    });
    await this["worldStore"].setGlobalActiveCharacter({
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
  };

  (
    DiscordAdapterClass.prototype as unknown as Record<string, unknown>
  ).resolveCharacterIdForVisibilityCommand = async function (
    this: DiscordAdapter,
    interaction: ChatInputCommandInteraction,
    characterId?: number,
  ): Promise<number> {
    return this["resolveCharacterIdFromInteraction"](interaction, characterId);
  };

  (
    DiscordAdapterClass.prototype as unknown as Record<string, unknown>
  ).resolveCharacterIdFromInteraction = async function (
    this: DiscordAdapter,
    interaction: ChatInputCommandInteraction,
    characterId?: number,
  ): Promise<number> {
    if (characterId && Number.isInteger(characterId) && characterId > 0) {
      return characterId;
    }
    const groupId = await this["worldStore"].getGroupIdByChannel(
      interaction.channelId,
    );
    const parsed = groupId ? parseCharacterGroup(groupId) : null;
    if (parsed?.kind === "build") {
      return parsed.characterId;
    }
    throw new Error("缺少 character_id：请显式提供，或在角色编辑话题中执行。");
  };

  (
    DiscordAdapterClass.prototype as unknown as Record<string, unknown>
  ).resolveJoinCharacterId = async function (
    this: DiscordAdapter,
    input: {
      userId: string;
      explicitCharacterId?: number;
    },
  ): Promise<number> {
    const explicit = input.explicitCharacterId;
    if (explicit && Number.isInteger(explicit) && explicit > 0) {
      const meta = await this["worldStore"].getCharacter(explicit);
      if (!meta) {
        throw new Error(`角色不存在：C${explicit}`);
      }
      if (meta.creatorId !== input.userId) {
        throw new Error("无权限：只能使用你自己创建的角色。");
      }
      return meta.id;
    }

    const globalActive = await this["worldStore"].getGlobalActiveCharacterId({
      userId: input.userId,
    });
    if (globalActive) {
      const meta = await this["worldStore"].getCharacter(globalActive);
      if (meta && meta.creatorId === input.userId) {
        return meta.id;
      }
    }

    const userCharacters = await this["worldStore"].listUserCharacterIds(
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
  };

  (
    DiscordAdapterClass.prototype as unknown as Record<string, unknown>
  ).ensureWorldSpecificCharacter = async function (
    this: DiscordAdapter,
    input: {
      worldId: number;
      worldName: string;
      userId: string;
      sourceCharacterId: number;
    },
  ): Promise<{
    characterId: number;
    sourceCharacterId: number;
    forked: boolean;
  }> {
    const sourceCharacterId = input.sourceCharacterId;
    const sourceCard =
      await this["worldFiles"].readCharacterCard(sourceCharacterId);
    if (sourceCard && hasWorldForkMarker(sourceCard, input.worldId)) {
      return {
        characterId: sourceCharacterId,
        sourceCharacterId,
        forked: false,
      };
    }

    const existingFork = await this["worldStore"].getWorldForkedCharacterId({
      worldId: input.worldId,
      userId: input.userId,
      sourceCharacterId,
    });
    if (existingFork) {
      return { characterId: existingFork, sourceCharacterId, forked: false };
    }

    const sourceMeta = await this["worldStore"].getCharacter(sourceCharacterId);
    if (!sourceMeta) {
      throw new Error(`角色不存在：C${sourceCharacterId}`);
    }

    const forkedCharacterId = await this["worldStore"].nextCharacterId();
    const nowIso = new Date().toISOString();
    const forkName = `${sourceMeta.name}-W${input.worldId}`;

    await this["worldStore"].createCharacter({
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
    await this["worldFiles"].writeCharacterCard(forkedCharacterId, forkedCard);
    await this["worldFiles"].appendCharacterEvent(forkedCharacterId, {
      type: "character_world_fork_created",
      worldId: input.worldId,
      worldName: input.worldName,
      sourceCharacterId,
      characterId: forkedCharacterId,
      userId: input.userId,
    });
    await this["worldStore"].setWorldForkedCharacterId({
      worldId: input.worldId,
      userId: input.userId,
      sourceCharacterId,
      forkedCharacterId,
    });

    return {
      characterId: forkedCharacterId,
      sourceCharacterId,
      forked: true,
    };
  };

  (
    DiscordAdapterClass.prototype as unknown as Record<string, unknown>
  ).maybeStartWorldCharacterAutoFix = async function (
    this: DiscordAdapter,
    input: {
      worldId: number;
      worldName: string;
      userId: string;
      characterId: number;
    },
  ): Promise<void> {
    const config = getConfig();
    const homeGuildId = config.DISCORD_HOME_GUILD_ID?.trim();
    if (!homeGuildId) {
      return;
    }
    const guild = await this["client"].guilds
      .fetch(homeGuildId)
      .catch(() => null);
    if (!guild) {
      return;
    }

    const meta = await this["worldStore"].getCharacter(input.characterId);
    const characterName =
      meta?.name?.trim() || `Character-${input.characterId}`;

    const workshop = await this["createCreatorOnlyChannel"]({
      guild,
      name: `character-workshop-${input.userId}`,
      creatorUserId: input.userId,
      reason: `character workshop ensure for ${input.userId}`,
    });
    const thread = await this["tryCreatePrivateThread"]({
      guild,
      parentChannelId: workshop.id,
      name: `世界修正 W${input.worldId} C${input.characterId}`,
      reason: `world character auto-fix W${input.worldId} C${input.characterId}`,
      memberUserId: input.userId,
    });
    if (!thread) {
      return;
    }

    const language = await this["userState"]
      .getLanguage(input.userId)
      .catch(() => null);
    await this["ensureWorldCharacterBuildGroupAgent"]({
      worldId: input.worldId,
      worldName: input.worldName,
      characterId: input.characterId,
      characterName,
      language,
    });
    await this["worldStore"].setChannelGroupId(
      thread.threadId,
      buildWorldCharacterBuildGroupId({
        worldId: input.worldId,
        characterId: input.characterId,
      }),
    );

    await this["sendLongTextToChannel"]({
      guildId: homeGuildId,
      channelId: thread.threadId,
      content: [
        `【世界专用角色卡修正】C${input.characterId}（W${input.worldId}）`,
        `我会尝试根据该世界的「世界书：规则」自动校正角色卡（只改角色卡，不改世界正典）。`,
        `你可以在本话题继续补充信息（不需要 @）。`,
      ].join("\n"),
    });

    await this["emitSyntheticWorldCharacterBuildKickoff"]({
      channelId: thread.threadId,
      userId: input.userId,
      worldId: input.worldId,
      worldName: input.worldName,
      characterId: input.characterId,
      characterName,
    });
  };

  (
    DiscordAdapterClass.prototype as unknown as Record<string, unknown>
  ).handleCharacterClose = async function (
    this: DiscordAdapter,
    interaction: ChatInputCommandInteraction,
  ): Promise<void> {
    await safeReply(
      interaction,
      "角色编辑话题不需要关闭（长期保留）。如需继续编辑：/character open character_id:<角色ID>。",
      { ephemeral: true },
    );
  };

  (
    DiscordAdapterClass.prototype as unknown as Record<string, unknown>
  ).tryCreatePrivateThread = async function (
    this: DiscordAdapter,
    input: {
      guild: NonNullable<ChatInputCommandInteraction["guild"]>;
      parentChannelId: string;
      name: string;
      reason: string;
      memberUserId: string;
    },
  ): Promise<{ threadId: string; parentChannelId: string } | null> {
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
      this["logger"].warn(
        { err, parentChannelId: resolvedParentId, threadName: input.name },
        "Failed to create private thread",
      );
      return null;
    }

    try {
      await thread.members?.add(input.memberUserId);
    } catch (err) {
      this["logger"].warn(
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
  };

  (
    DiscordAdapterClass.prototype as unknown as Record<string, unknown>
  ).reopenPrivateThreadForUser = async function (
    this: DiscordAdapter,
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
  };

  (
    DiscordAdapterClass.prototype as unknown as Record<string, unknown>
  ).createCreatorOnlyChannel = async function (
    this: DiscordAdapter,
    input: {
      guild: NonNullable<ChatInputCommandInteraction["guild"]>;
      name: string;
      creatorUserId: string;
      reason: string;
    },
  ): Promise<{ id: string }> {
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
        const botUserId = this["botUserId"] ?? this["client"].user?.id ?? "";
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

    const botUserId = this["botUserId"] ?? this["client"].user?.id ?? "";
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
  };

  (
    DiscordAdapterClass.prototype as unknown as Record<string, unknown>
  ).ensureOnboardingThread = async function (
    this: DiscordAdapter,
    input: {
      guild: Guild;
      userId: string;
      role: UserRole;
      language: UserLanguage | null | undefined;
      reason: string;
    },
  ): Promise<string> {
    const workshop = await this["createCreatorOnlyChannel"]({
      guild: input.guild,
      name: `onboarding-${input.userId}`,
      creatorUserId: input.userId,
      reason: `onboarding workshop ensure for ${input.userId}`,
    });

    const existingThreadId = await this["userState"].getOnboardingThreadId({
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

    const thread = await this["tryCreatePrivateThread"]({
      guild: input.guild,
      parentChannelId: workshop.id,
      name: pickByLanguage(
        input.language,
        input.role === "world creater" ? "世界创建者指南" : "冒险者指南",
        input.role === "world creater"
          ? "World Creater Guide"
          : "Adventurer Guide",
      ),
      reason: input.reason,
      memberUserId: input.userId,
    });
    const channelId = thread?.threadId ?? workshop.id;
    await this["userState"].setOnboardingThreadId({
      userId: input.userId,
      role: input.role,
      threadId: channelId,
    });
    return channelId;
  };

  (
    DiscordAdapterClass.prototype as unknown as Record<string, unknown>
  ).migrateWorldAgents = async function (this: DiscordAdapter): Promise<void> {
    const ids = await this["worldStore"].listWorldIds(200);
    for (const id of ids) {
      const meta = await this["worldStore"].getWorld(id);
      if (!meta) {
        continue;
      }
      try {
        const language = await this["userState"]
          .getLanguage(meta.creatorId)
          .catch(() => null);
        await this["ensureWorldBuildGroupAgent"]({
          worldId: meta.id,
          worldName: meta.name,
          language,
        });
        if (meta.status !== "draft") {
          await this["ensureWorldGroupAgent"]({
            worldId: meta.id,
            worldName: meta.name,
            language,
          });
        }
      } catch (err) {
        this["logger"].warn(
          { err, worldId: meta.id, guildId: meta.homeGuildId },
          "Failed to migrate world agents",
        );
      }
    }
  };

  (
    DiscordAdapterClass.prototype as unknown as Record<string, unknown>
  ).inferWorldIdFromWorldSubspace = async function (
    this: DiscordAdapter,
    interaction: ChatInputCommandInteraction,
  ): Promise<number | null> {
    const channelId = interaction.channelId?.trim();
    if (!channelId || !interaction.guild) {
      return null;
    }

    const direct = await this["worldStore"].getWorldIdByChannel(channelId);
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
      const ids = await this["worldStore"].listWorldIds(200);
      for (const id of ids) {
        const meta = await this["worldStore"].getWorld(id);
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
        if (meta.forumChannelId && meta.forumChannelId === baseChannelId) {
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
    const mapped = await this["worldStore"].getWorldIdByCategory(categoryId);
    if (mapped) {
      return mapped;
    }

    const ids = await this["worldStore"].listWorldIds(200);
    for (const id of ids) {
      const meta = await this["worldStore"].getWorld(id);
      if (
        meta &&
        meta.status !== "draft" &&
        "categoryId" in meta &&
        meta.categoryId === categoryId
      ) {
        await this["worldStore"].setCategoryWorldId(categoryId, meta.id);
        return meta.id;
      }
    }
    return null;
  };

  (
    DiscordAdapterClass.prototype as unknown as Record<string, unknown>
  ).resolveBaseChannelId = async function (
    this: DiscordAdapter,
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
  };

  (
    DiscordAdapterClass.prototype as unknown as Record<string, unknown>
  ).sendLongTextToChannel = async function (
    this: DiscordAdapter,
    input: {
      guildId?: string;
      channelId: string;
      content: string;
      traceId?: string;
    },
  ): Promise<void> {
    const botId = this["botUserId"]?.trim() ?? this["client"].user?.id ?? "";
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
      await this["sendMessage"](session, chunk);
    }
  };

  (
    DiscordAdapterClass.prototype as unknown as Record<string, unknown>
  ).sendRichToChannel = async function (
    this: DiscordAdapter,
    input: {
      guildId?: string;
      channelId: string;
      content?: string;
      embeds?: APIEmbed[];
      files?: Array<{ name: string; content: string }>;
      components?: MessageCreateOptions["components"];
      traceId?: string;
    },
  ): Promise<void> {
    const botId = this["botUserId"]?.trim() ?? this["client"].user?.id ?? "";
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

    const channel = await this["client"].channels
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

    const payload: MessageCreateOptions = {};
    if (content) {
      payload.content = content;
    }
    if (embeds.length > 0) {
      payload.embeds = embeds;
    }
    if (input.components && input.components.length > 0) {
      payload.components = input.components;
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
      this["logger"].warn(
        { err, channelId: input.channelId },
        "Failed to send rich message",
      );
    }
  };

  (
    DiscordAdapterClass.prototype as unknown as Record<string, unknown>
  ).pushWorldInfoSnapshot = async function (
    this: DiscordAdapter,
    input: {
      guildId: string;
      worldId: number;
      worldName: string;
      infoChannelId: string;
      traceId?: string;
    },
  ): Promise<void> {
    const nowIso = new Date().toISOString();
    const [meta, card, rules, stats] = await Promise.all([
      this["worldStore"].getWorld(input.worldId),
      this["worldFiles"].readWorldCard(input.worldId),
      this["worldFiles"].readRules(input.worldId),
      this["worldFiles"].readStats(input.worldId),
    ]);
    const creatorLabel =
      meta?.creatorId && meta.creatorId.trim()
        ? await this["resolveDiscordUserLabel"]({
            userId: meta.creatorId,
            guild: this["client"].guilds.cache.get(input.guildId) ?? null,
          })
        : null;
    const patchedCard =
      card?.trim() && meta?.creatorId
        ? patchCreatorLineInMarkdown(card.trim(), meta.creatorId, creatorLabel)
        : card?.trim()
          ? card.trim()
          : "";
    const patchedRules = rules?.trim() ? rules.trim() : "";
    const wikiLinks = buildWorldWikiLinks({
      worldId: input.worldId,
      baseUrl: getConfig().WIKI_PUBLIC_BASE_URL,
    });

    const embeds: APIEmbed[] = [
      {
        title: `【世界信息】W${input.worldId} ${input.worldName}`,
        description: [
          `更新时间：${nowIso}`,
          creatorLabel ? `创作者：${creatorLabel}` : null,
          `访客数：${stats.visitorCount} 角色数：${stats.characterCount}`,
          `加入：\`/world join world_id:${input.worldId}\``,
          wikiLinks ? `Wiki（中文）：${wikiLinks.zhWorldCard}` : null,
          wikiLinks ? `Wiki（English）：${wikiLinks.enWorldCard}` : null,
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
      await this["sendRichToChannel"]({
        guildId: input.guildId,
        channelId: input.infoChannelId,
        embeds: chunk,
        traceId: input.traceId,
      });
    }
  };

  (
    DiscordAdapterClass.prototype as unknown as Record<string, unknown>
  ).createWorldSubspace = async function (
    this: DiscordAdapter,
    input: {
      guild: Guild;
      worldId: number;
      worldName: string;
      creatorUserId: string;
    },
  ): Promise<{
    roleId: string;
    categoryId: string;
    infoChannelId: string;
    discussionChannelId: string;
    forumChannelId: string;
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

    const botId = this["botUserId"] ?? "";
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

    let forumChannelMode: "forum" | "text" = "forum";
    const forumChannel = await input.guild.channels
      .create({
        name: "world-forum",
        type: ChannelType.GuildForum,
        parent: category.id,
        permissionOverwrites: baseOverwrites.forum,
        reason: `world publish by ${input.creatorUserId}`,
      })
      .catch(async (err) => {
        this["logger"].warn(
          { err, worldId: input.worldId, guildId: input.guild.id },
          "Failed to create world forum channel; fallback to text",
        );
        forumChannelMode = "text";
        return input.guild.channels.create({
          name: "world-forum",
          type: ChannelType.GuildText,
          parent: category.id,
          permissionOverwrites: baseOverwrites.forum,
          reason: `world publish by ${input.creatorUserId}`,
        });
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

    await this["worldFiles"].appendEvent(input.worldId, {
      type: "world_subspace_created",
      worldId: input.worldId,
      guildId: input.guild.id,
      userId: input.creatorUserId,
      roleId: role.id,
      categoryId: category.id,
      infoChannelId: infoChannel.id,
      discussionChannelId: discussionChannel.id,
      forumChannelId: forumChannel.id,
      forumChannelMode,
      proposalsChannelId: proposalsChannel.id,
      voiceChannelId: voiceChannel.id,
    });

    return {
      roleId: role.id,
      categoryId: category.id,
      infoChannelId: infoChannel.id,
      discussionChannelId: discussionChannel.id,
      forumChannelId: forumChannel.id,
      proposalsChannelId: proposalsChannel.id,
      voiceChannelId: voiceChannel.id,
    };
  };
}
