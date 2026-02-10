import type { DiscordAdapter } from "./adapter";
import { buildCharacterBuildGroupId } from "../../character/ids";
import { feishuLogJson } from "../../feishu/webhook";
import { createTraceId } from "../../telemetry";
import {
  buildCharacterSourceSeedContent,
  buildDefaultCharacterCard,
  buildDiscordCharacterHelp,
} from "../../texts";
import type { UserLanguage } from "../../user/state-store";
import type { CharacterVisibility } from "../../world/store";
import { LocalizedError, pickByLanguage } from "./adapter-internals";
import {
  extractCharacterNameFromCard,
  extractWorldNameFromCard,
  extractWorldOneLiner,
} from "./card-parsers";
import { safeDefer, safeReply, safeReplyRich } from "./interaction-helpers";
import {
  buildMarkdownCardEmbeds,
  chunkEmbedsForDiscord,
} from "./markdown-cards";
import {
  DEFAULT_DISCORD_TEXT_ATTACHMENT_MAX_BYTES,
  fetchDiscordTextAttachment,
} from "./text-attachments";
import { isAllowedWikiImportFilename } from "./url-helpers";
import {
  type APIEmbed,
  Attachment,
  ChannelType,
  ChatInputCommandInteraction,
  Guild,
} from "discord.js";
import { rm } from "node:fs/promises";

export function installDiscordAdapterWorldCharacterEntry(DiscordAdapterClass: {
  prototype: DiscordAdapter;
}): void {
  (
    DiscordAdapterClass.prototype as unknown as Record<string, unknown>
  ).handleWorldJoin = async function (
    this: DiscordAdapter,
    interaction: ChatInputCommandInteraction,
    input: { worldId: number; characterId?: number },
  ): Promise<void> {
    const language = await this["userState"]
      .getLanguage(interaction.user.id)
      .catch(() => null);
    await safeDefer(interaction, { ephemeral: true });
    const meta = await this["worldStore"].getWorld(input.worldId);
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
      const joined = await this["joinWorldForUser"]({
        guildId: interaction.guildId,
        guild: interaction.guild,
        userId: interaction.user.id,
        worldId: input.worldId,
        language,
        explicitCharacterId: input.characterId,
      });

      await safeReply(
        interaction,
        pickByLanguage(
          language,
          [
            `已加入世界：W${joined.worldId} ${joined.worldName}`,
            `讨论：<#${joined.roleplayChannelId}>`,
            joined.forumChannelId ? `论坛：<#${joined.forumChannelId}>` : null,
            `当前角色：C${joined.characterId} ${joined.characterName}${
              joined.forked
                ? `（本世界专用，fork自 C${joined.sourceCharacterId}）`
                : ""
            }`,
          ]
            .filter((line): line is string => Boolean(line))
            .join("\n"),
          [
            `Joined world: W${joined.worldId} ${joined.worldName}`,
            `Discussion: <#${joined.roleplayChannelId}>`,
            joined.forumChannelId ? `Forum: <#${joined.forumChannelId}>` : null,
            `Active character: C${joined.characterId} ${joined.characterName}${
              joined.forked
                ? ` (world-specific; forked from C${joined.sourceCharacterId})`
                : ""
            }`,
          ]
            .filter((line): line is string => Boolean(line))
            .join("\n"),
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
  };

  (
    DiscordAdapterClass.prototype as unknown as Record<string, unknown>
  ).joinWorldForUser = async function (
    this: DiscordAdapter,
    input: {
      guildId: string;
      guild: Guild;
      userId: string;
      worldId: number;
      language: UserLanguage | null;
      explicitCharacterId?: number;
    },
  ): Promise<{
    worldId: number;
    worldName: string;
    roleplayChannelId: string;
    forumChannelId?: string;
    characterId: number;
    characterName: string;
    forked: boolean;
    sourceCharacterId: number;
  }> {
    const meta = await this["worldStore"].getWorld(input.worldId);
    if (!meta) {
      throw new LocalizedError({
        zh: `世界不存在：W${input.worldId}`,
        en: `World not found: W${input.worldId}`,
      });
    }
    if (meta.status !== "active") {
      throw new LocalizedError({
        zh: `无法加入：世界尚未发布（W${meta.id} 当前状态=${meta.status}）`,
        en: `Cannot join: world is not published yet (W${meta.id} status=${meta.status})`,
      });
    }
    if (input.guildId !== meta.homeGuildId) {
      throw new LocalizedError({
        zh: `无法加入：该世界入口在 guild:${meta.homeGuildId}（请先加入该服务器后再加入世界）。`,
        en: `Cannot join: this world's entry server is guild:${meta.homeGuildId} (join that server first).`,
      });
    }

    try {
      const worldCard = await this["worldFiles"]
        .readWorldCard(meta.id)
        .catch(() => null);
      const resolvedWorldName =
        extractWorldNameFromCard(worldCard)?.trim() || meta.name;

      const member = await input.guild.members.fetch(input.userId);
      await member.roles.add(meta.roleId, "world join");
      await this["worldStore"]
        .addMember(meta.id, input.userId)
        .catch(() => false);
      const persisted = await this["worldFiles"]
        .ensureMember(meta.id, input.userId)
        .catch(async () => ({
          added: false,
          stats: await this["worldFiles"].readStats(meta.id),
        }));
      if (persisted.added) {
        await this["worldFiles"].appendEvent(meta.id, {
          type: "world_joined",
          worldId: meta.id,
          userId: input.userId,
        });
      }

      const selectedCharacterId = await this["resolveJoinCharacterId"]({
        userId: input.userId,
        explicitCharacterId: input.explicitCharacterId,
      });
      const worldCharacter = await this["ensureWorldSpecificCharacter"]({
        worldId: meta.id,
        worldName: resolvedWorldName,
        userId: input.userId,
        sourceCharacterId: selectedCharacterId,
      });

      const worldCharacterMeta = await this["worldStore"]
        .getCharacter(worldCharacter.characterId)
        .catch(() => null);
      const worldCharacterCard = await this["worldFiles"]
        .readCharacterCard(worldCharacter.characterId)
        .catch(() => null);
      const resolvedCharacterName =
        extractCharacterNameFromCard(worldCharacterCard)?.trim() ||
        worldCharacterMeta?.name?.trim() ||
        `Character-${worldCharacter.characterId}`;

      await this["worldStore"].setActiveCharacter({
        worldId: meta.id,
        userId: input.userId,
        characterId: worldCharacter.characterId,
      });
      await this["worldStore"]
        .addCharacterToWorld(meta.id, worldCharacter.characterId)
        .catch(() => false);
      await this["worldFiles"]
        .ensureWorldCharacter(meta.id, worldCharacter.characterId)
        .catch(() => {});

      await this["userState"]
        .addJoinedWorld(input.userId, meta.id)
        .catch(() => {});

      if (worldCharacter.forked) {
        await this["maybeStartWorldCharacterAutoFix"]({
          worldId: meta.id,
          worldName: resolvedWorldName,
          userId: input.userId,
          characterId: worldCharacter.characterId,
        }).catch((err) => {
          this["logger"].warn(
            { err },
            "Failed to start world character auto-fix",
          );
        });
      }

      return {
        worldId: meta.id,
        worldName: resolvedWorldName,
        roleplayChannelId: meta.roleplayChannelId,
        forumChannelId: meta.forumChannelId,
        characterId: worldCharacter.characterId,
        characterName: resolvedCharacterName,
        forked: worldCharacter.forked,
        sourceCharacterId: worldCharacter.sourceCharacterId,
      };
    } catch (err) {
      throw new LocalizedError({
        zh: `加入失败：${err instanceof Error ? err.message : String(err)}`,
        en: `Failed to join: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  };

  (
    DiscordAdapterClass.prototype as unknown as Record<string, unknown>
  ).handleWorldStats = async function (
    this: DiscordAdapter,
    interaction: ChatInputCommandInteraction,
    worldId: number,
  ): Promise<void> {
    await safeDefer(interaction, { ephemeral: false });
    const meta = await this["worldStore"].getWorld(worldId);
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
    const stats = await this["worldFiles"].readStats(meta.id);
    await safeReply(
      interaction,
      `W${meta.id} ${meta.name}\n状态：${
        meta.status === "draft" ? "draft(未发布)" : meta.status
      }\n访客数：${stats.visitorCount}\n角色数：${stats.characterCount}`,
      { ephemeral: false },
    );
  };

  (
    DiscordAdapterClass.prototype as unknown as Record<string, unknown>
  ).handleWorldSearch = async function (
    this: DiscordAdapter,
    interaction: ChatInputCommandInteraction,
    input: { query: string; limit?: number },
  ): Promise<void> {
    const language = await this["userState"]
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

    const ids = await this["worldStore"].listWorldIds(200);
    if (ids.length === 0) {
      await safeReply(
        interaction,
        pickByLanguage(language, "暂无世界。", "No worlds yet."),
        { ephemeral: false },
      );
      return;
    }

    const metas = await Promise.all(
      ids.map((id) => this["worldStore"].getWorld(id)),
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
        const card = await this["worldFiles"].readWorldCard(meta.id);
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
        this["worldFiles"].readWorldCard(meta.id),
        this["worldFiles"].readRules(meta.id),
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
  };

  (
    DiscordAdapterClass.prototype as unknown as Record<string, unknown>
  ).handleWorldEdit = async function (
    this: DiscordAdapter,
    interaction: ChatInputCommandInteraction,
    input: { worldId: number; message?: string; document?: Attachment },
  ): Promise<void> {
    await safeReply(
      interaction,
      `该指令已弃用：请使用 /world open world_id:${input.worldId} 打开编辑话题，然后在编辑话题里继续编辑并 /world publish 发布。`,
      { ephemeral: true },
    );
  };

  (
    DiscordAdapterClass.prototype as unknown as Record<string, unknown>
  ).handleWorldDone = async function (
    this: DiscordAdapter,
    interaction: ChatInputCommandInteraction,
  ): Promise<void> {
    await safeReply(
      interaction,
      "请在世界编辑话题中执行 /world publish 发布。",
      {
        ephemeral: true,
      },
    );
  };

  (
    DiscordAdapterClass.prototype as unknown as Record<string, unknown>
  ).handleWorldRemove = async function (
    this: DiscordAdapter,
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

    const groupPath = await this["groupRepository"].ensureGroupDir(
      interaction.guildId,
    );
    const groupConfig = await this["groupRepository"].loadConfig(groupPath);
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

    const meta = await this["worldStore"].getWorld(worldId);
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
          meta.forumChannelId,
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

    const purge = await this["worldStore"].purgeWorld(meta);
    await rm(this["worldFiles"].worldDir(meta.id), {
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
  };

  (
    DiscordAdapterClass.prototype as unknown as Record<string, unknown>
  ).handleCharacterCommand = async function (
    this: DiscordAdapter,
    interaction: ChatInputCommandInteraction,
    _flags: { isGuildOwner: boolean; isGuildAdmin: boolean },
  ): Promise<void> {
    const subcommand = interaction.options.getSubcommand();
    if (subcommand === "create") {
      await this["handleCharacterCreate"](interaction);
      return;
    }
    if (subcommand === "help") {
      await this["handleCharacterHelp"](interaction);
      return;
    }
    if (subcommand === "open") {
      const characterId = interaction.options.getInteger("character_id", true);
      await this["handleCharacterOpen"](interaction, characterId);
      return;
    }
    if (subcommand === "export") {
      const characterId =
        interaction.options.getInteger("character_id") ?? undefined;
      await this["handleCharacterExport"](interaction, { characterId });
      return;
    }
    if (subcommand === "import") {
      const file = interaction.options.getAttachment("file", true);
      const characterId =
        interaction.options.getInteger("character_id") ?? undefined;
      await this["handleCharacterImport"](interaction, { file, characterId });
      return;
    }
    if (subcommand === "view") {
      const characterId = interaction.options.getInteger("character_id", true);
      await this["handleCharacterView"](interaction, characterId);
      return;
    }
    if (subcommand === "act") {
      const characterId = interaction.options.getInteger("character_id", true);
      await this["handleCharacterAct"](interaction, characterId);
      return;
    }
    if (subcommand === "use") {
      const characterId = interaction.options.getInteger("character_id", true);
      await this["handleCharacterUse"](interaction, characterId);
      return;
    }
    if (subcommand === "publish") {
      const characterId =
        interaction.options.getInteger("character_id") ?? undefined;
      await this["handleCharacterPublish"](interaction, characterId);
      return;
    }
    if (subcommand === "unpublish") {
      const characterId =
        interaction.options.getInteger("character_id") ?? undefined;
      await this["handleCharacterUnpublish"](interaction, characterId);
      return;
    }
    if (subcommand === "list") {
      const limit = interaction.options.getInteger("limit") ?? undefined;
      await this["handleCharacterList"](interaction, { limit });
      return;
    }
    if (subcommand === "search") {
      const query = interaction.options.getString("query", true);
      const limit = interaction.options.getInteger("limit") ?? undefined;
      await this["handleCharacterSearch"](interaction, { query, limit });
      return;
    }
    if (subcommand === "adopt") {
      const characterId = interaction.options.getInteger("character_id", true);
      const modeRaw = interaction.options.getString("mode", true);
      const mode = modeRaw === "fork" ? "fork" : "copy";
      await this["handleCharacterAdopt"](interaction, { characterId, mode });
      return;
    }
    await safeReply(interaction, `未知子命令：/character ${subcommand}`, {
      ephemeral: false,
    });
  };

  (
    DiscordAdapterClass.prototype as unknown as Record<string, unknown>
  ).handleCharacterCreate = async function (
    this: DiscordAdapter,
    interaction: ChatInputCommandInteraction,
  ): Promise<void> {
    const language = await this["userState"]
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

      characterId = await this["worldStore"].nextCharacterId();
      const nowIso = new Date().toISOString();
      const name = nameRaw || `Character-${characterId}`;
      await this["worldStore"].createCharacter({
        id: characterId,
        creatorId: interaction.user.id,
        name,
        visibility,
        status: "active",
        createdAt: nowIso,
        updatedAt: nowIso,
      });
      await this["worldFiles"].writeCharacterCard(
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
      await this["worldFiles"].writeCharacterSourceDocument(
        characterId,
        source,
      );
      await this["worldFiles"].appendCharacterEvent(characterId, {
        type: "character_created",
        characterId,
        userId: interaction.user.id,
      });
      await this["worldFiles"].appendCharacterEvent(characterId, {
        type: "character_source_uploaded",
        characterId,
        userId: interaction.user.id,
        filename: source.filename,
      });
      await this["userState"].markCharacterCreated(interaction.user.id);

      await this["ensureCharacterBuildGroupAgent"]({
        characterId,
        characterName: name,
        language,
      });

      const workshop = await this["createCreatorOnlyChannel"]({
        guild: interaction.guild,
        name: `character-workshop-${interaction.user.id}`,
        creatorUserId: interaction.user.id,
        reason: `character workshop ensure for ${interaction.user.id}`,
      });
      const thread = await this["tryCreatePrivateThread"]({
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

      await this["worldStore"].setCharacterBuildChannelId({
        characterId,
        channelId: buildConversationChannelId,
      });
      await this["worldStore"].setChannelGroupId(
        buildConversationChannelId,
        buildCharacterBuildGroupId(characterId),
      );

      await this["sendCharacterCreateRules"]({
        guildId: interaction.guildId,
        channelId: buildConversationChannelId,
        userId: interaction.user.id,
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
      this["logger"].error({ err }, "Failed to create character");
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
  };

  (
    DiscordAdapterClass.prototype as unknown as Record<string, unknown>
  ).createCharacterDraftAndThread = async function (
    this: DiscordAdapter,
    input: {
      guild: Guild;
      guildId: string;
      userId: string;
      language: UserLanguage | null;
      traceId?: string;
      visibility: CharacterVisibility;
      name?: string;
      description?: string;
    },
  ): Promise<{
    characterId: number;
    characterName: string;
    visibility: CharacterVisibility;
    buildConversationChannelId: string;
    threadCreated: boolean;
  }> {
    const visibility =
      input.visibility === "public"
        ? ("public" as const)
        : ("private" as const);
    const description = input.description?.trim() ?? "";
    const nameRaw = input.name?.trim() ?? "";

    const characterId = await this["worldStore"].nextCharacterId();
    const nowIso = new Date().toISOString();
    const name = nameRaw || `Character-${characterId}`;

    await this["worldStore"].createCharacter({
      id: characterId,
      creatorId: input.userId,
      name,
      visibility,
      status: "active",
      createdAt: nowIso,
      updatedAt: nowIso,
    });

    await this["worldFiles"].writeCharacterCard(
      characterId,
      buildDefaultCharacterCard({
        characterId,
        name,
        creatorId: input.userId,
        description,
        language: input.language,
      }),
    );

    const source = {
      filename: "source.md",
      content: buildCharacterSourceSeedContent(input.language),
    };
    await this["worldFiles"].writeCharacterSourceDocument(characterId, source);
    await this["worldFiles"].appendCharacterEvent(characterId, {
      type: "character_created",
      characterId,
      userId: input.userId,
    });
    await this["worldFiles"].appendCharacterEvent(characterId, {
      type: "character_source_uploaded",
      characterId,
      userId: input.userId,
      filename: source.filename,
    });
    await this["userState"].markCharacterCreated(input.userId);

    await this["ensureCharacterBuildGroupAgent"]({
      characterId,
      characterName: name,
      language: input.language,
    });

    const workshop = await this["createCreatorOnlyChannel"]({
      guild: input.guild,
      name: `character-workshop-${input.userId}`,
      creatorUserId: input.userId,
      reason: `character workshop ensure for ${input.userId}`,
    });
    const thread = await this["tryCreatePrivateThread"]({
      guild: input.guild,
      parentChannelId: workshop.id,
      name: pickByLanguage(
        input.language,
        `角色创建 C${characterId}`,
        `Character Create C${characterId}`,
      ),
      reason: `character create C${characterId} by ${input.userId}`,
      memberUserId: input.userId,
    });

    const buildConversationChannelId = thread?.threadId ?? workshop.id;

    await this["worldStore"].setCharacterBuildChannelId({
      characterId,
      channelId: buildConversationChannelId,
    });
    await this["worldStore"].setChannelGroupId(
      buildConversationChannelId,
      buildCharacterBuildGroupId(characterId),
    );

    await this["sendCharacterCreateRules"]({
      guildId: input.guildId,
      channelId: buildConversationChannelId,
      userId: input.userId,
      characterId,
      language: input.language,
      traceId: input.traceId,
    });

    return {
      characterId,
      characterName: name,
      visibility,
      buildConversationChannelId,
      threadCreated: Boolean(thread),
    };
  };

  (
    DiscordAdapterClass.prototype as unknown as Record<string, unknown>
  ).handleCharacterHelp = async function (
    this: DiscordAdapter,
    interaction: ChatInputCommandInteraction,
  ): Promise<void> {
    const language = await this["userState"]
      .getLanguage(interaction.user.id)
      .catch(() => null);
    await safeReply(interaction, buildDiscordCharacterHelp(language), {
      ephemeral: true,
    });
  };

  (
    DiscordAdapterClass.prototype as unknown as Record<string, unknown>
  ).handleCharacterExport = async function (
    this: DiscordAdapter,
    interaction: ChatInputCommandInteraction,
    input: { characterId?: number },
  ): Promise<void> {
    await safeDefer(interaction, { ephemeral: true });
    let characterId: number;
    try {
      characterId = await this["resolveCharacterIdFromInteraction"](
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

    const meta = await this["worldStore"].getCharacter(characterId);
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

    const content = await this["worldFiles"].readCharacterCard(meta.id);
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
  };

  (
    DiscordAdapterClass.prototype as unknown as Record<string, unknown>
  ).handleCharacterImport = async function (
    this: DiscordAdapter,
    interaction: ChatInputCommandInteraction,
    input: { file: Attachment; characterId?: number },
  ): Promise<void> {
    await safeDefer(interaction, { ephemeral: true });
    let characterId: number;
    try {
      characterId = await this["resolveCharacterIdFromInteraction"](
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

    const meta = await this["worldStore"].getCharacter(characterId);
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
        logger: this["logger"],
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

    await this["worldFiles"].writeCharacterCard(meta.id, doc.content);
    await this["worldFiles"].appendCharacterEvent(meta.id, {
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
  };

  (
    DiscordAdapterClass.prototype as unknown as Record<string, unknown>
  ).handleCharacterView = async function (
    this: DiscordAdapter,
    interaction: ChatInputCommandInteraction,
    characterId: number,
  ): Promise<void> {
    const meta = await this["worldStore"].getCharacter(characterId);
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

    const card = await this["worldFiles"].readCharacterCard(meta.id);
    if (!card) {
      await safeReply(interaction, "角色卡缺失（待修复）。", {
        ephemeral,
      });
      return;
    }
    const creatorLabel = await this["resolveDiscordUserLabel"]({
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
  };

  (
    DiscordAdapterClass.prototype as unknown as Record<string, unknown>
  ).handleCharacterAct = async function (
    this: DiscordAdapter,
    interaction: ChatInputCommandInteraction,
    characterId: number,
  ): Promise<void> {
    const language = await this["userState"]
      .getLanguage(interaction.user.id)
      .catch(() => null);
    await safeDefer(interaction, { ephemeral: false });
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

    const inferredWorldId = interaction.channelId
      ? await this["worldStore"].getWorldIdByChannel(interaction.channelId)
      : null;
    const worldId =
      inferredWorldId ??
      (await this["inferWorldIdFromWorldSubspace"](interaction).catch(
        () => null,
      ));
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
      (await this["worldStore"]
        .isMember(worldId, interaction.user.id)
        .catch(() => false)) ||
      (await this["worldFiles"]
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

    const worldMeta = await this["worldStore"].getWorld(worldId);
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

    const worldCharacter = await this["ensureWorldSpecificCharacter"]({
      worldId: worldMeta.id,
      worldName: worldMeta.name,
      userId: interaction.user.id,
      sourceCharacterId: meta.id,
    });
    await this["worldStore"].setActiveCharacter({
      worldId: worldMeta.id,
      userId: interaction.user.id,
      characterId: worldCharacter.characterId,
    });
    await this["worldStore"]
      .addCharacterToWorld(worldMeta.id, worldCharacter.characterId)
      .catch(() => false);
    await this["worldFiles"]
      .ensureWorldCharacter(worldMeta.id, worldCharacter.characterId)
      .catch(() => {});
    if (worldCharacter.forked) {
      await this["maybeStartWorldCharacterAutoFix"]({
        worldId: worldMeta.id,
        worldName: worldMeta.name,
        userId: interaction.user.id,
        characterId: worldCharacter.characterId,
      }).catch((err) => {
        this["logger"].warn(
          { err },
          "Failed to start world character auto-fix",
        );
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
  };

  (
    DiscordAdapterClass.prototype as unknown as Record<string, unknown>
  ).handleCharacterOpen = async function (
    this: DiscordAdapter,
    interaction: ChatInputCommandInteraction,
    characterId: number,
  ): Promise<void> {
    const language = await this["userState"]
      .getLanguage(interaction.user.id)
      .catch(() => null);
    await safeDefer(interaction, { ephemeral: true });
    try {
      const meta = await this["worldStore"].getCharacter(characterId);
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

      await this["ensureCharacterBuildGroupAgent"]({
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

      const workshop = await this["createCreatorOnlyChannel"]({
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
        await this["reopenPrivateThreadForUser"](fetched, interaction.user.id, {
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
        const thread = await this["tryCreatePrivateThread"]({
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

        await this["worldStore"].setCharacterBuildChannelId({
          characterId: meta.id,
          channelId: conversationChannelId,
        });
        await this["sendCharacterCreateRules"]({
          guildId: interaction.guildId,
          channelId: conversationChannelId,
          userId: interaction.user.id,
          characterId: meta.id,
          language,
        });
      }

      await this["worldStore"].setChannelGroupId(
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
      this["logger"].error(
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
  };
}
