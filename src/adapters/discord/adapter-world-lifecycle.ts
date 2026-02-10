import type { DiscordAdapter } from "./adapter";
import { parseCharacterGroup } from "../../character/ids";
import { buildWorldSubmissionMarkdown } from "../../texts";
import type { UserLanguage } from "../../user/state-store";
import { isSafePathSegment } from "../../utils/path";
import { buildWorldBuildGroupId, parseWorldGroup } from "../../world/ids";
import { WorldStore } from "../../world/store";
import {
  DEFAULT_DISCORD_IMAGE_ATTACHMENT_MAX_BYTES,
  DEFAULT_DISCORD_IMAGE_ATTACHMENT_TIMEOUT_MS,
  LocalizedError,
  pickByLanguage,
  resolveUserMessageFromError,
} from "./adapter-internals";
import { extractWorldNameFromCard, extractWorldOneLiner } from "./card-parsers";
import { patchCreatorLineInMarkdown } from "./character-card-variants";
import { fetchDiscordImageAttachment } from "./image-fetcher";
import { safeDefer, safeReply, safeReplyRich } from "./interaction-helpers";
import {
  buildMarkdownCardEmbeds,
  chunkEmbedsForDiscord,
} from "./markdown-cards";
import {
  DEFAULT_DISCORD_TEXT_ATTACHMENT_MAX_BYTES,
  fetchDiscordTextAttachment,
} from "./text-attachments";
import {
  isAllowedWikiImportFilename,
  resolveCanonImportFilename,
} from "./url-helpers";
import {
  buildWorldDiscussionGuide,
  buildWorldProposalsGuide,
  parseWorldSubmissionMarkdown,
} from "./world-showcase-builders";
import type { WorldShowcaseCoverImage } from "./world-showcase-message";
import type {
  APIEmbed,
  Attachment,
  ChatInputCommandInteraction,
} from "discord.js";

export function installDiscordAdapterWorldLifecycle(DiscordAdapterClass: {
  prototype: DiscordAdapter;
}): void {
  (
    DiscordAdapterClass.prototype as unknown as Record<string, unknown>
  ).handleWorldImport = async function (
    this: DiscordAdapter,
    interaction: ChatInputCommandInteraction,
    input: { kind: string; file: Attachment; worldId?: number },
  ): Promise<void> {
    await safeDefer(interaction, { ephemeral: true });
    const worldId =
      input.worldId ??
      (await this["inferWorldIdFromWorldSubspace"](interaction).catch(
        () => null,
      ));
    if (!worldId) {
      await safeReply(
        interaction,
        "缺少 world_id：请在世界子空间/编辑话题内执行，或显式提供 world_id。",
        { ephemeral: true },
      );
      return;
    }

    const meta = await this["worldStore"].getWorld(worldId);
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

    const kind = input.kind.trim();
    let target: string;
    if (kind === "world_card") {
      await this["worldFiles"].writeWorldCard(meta.id, doc.content);
      target = "world-card.md";
    } else if (kind === "rules") {
      await this["worldFiles"].writeRules(meta.id, doc.content);
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

      await this["worldFiles"].writeCanon(meta.id, canonFilename, doc.content);
      target = `canon/${canonFilename}`;
    } else {
      await safeReply(
        interaction,
        `未知 kind：${kind}（可选：world_card/rules/canon）`,
        { ephemeral: true },
      );
      return;
    }

    await this["worldFiles"].appendEvent(meta.id, {
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
  };

  (
    DiscordAdapterClass.prototype as unknown as Record<string, unknown>
  ).handleWorldImageUpload = async function (
    this: DiscordAdapter,
    interaction: ChatInputCommandInteraction,
    input: { name: string; file: Attachment; worldId?: number },
  ): Promise<void> {
    await safeDefer(interaction, { ephemeral: true });

    const worldId =
      input.worldId ??
      (await this["inferWorldIdFromWorldSubspace"](interaction).catch(
        () => null,
      ));
    if (!worldId) {
      await safeReply(
        interaction,
        "缺少 world_id：请在世界子空间/编辑话题内执行，或显式提供 world_id。",
        { ephemeral: true },
      );
      return;
    }

    const meta = await this["worldStore"].getWorld(worldId);
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
      await safeReply(
        interaction,
        "无权限：只有世界创作者可以上传世界素材图。",
        {
          ephemeral: true,
        },
      );
      return;
    }

    const assetName = input.name.trim();
    if (!assetName) {
      await safeReply(interaction, "name 不能为空。", { ephemeral: true });
      return;
    }

    let image: { filename: string; contentType: string; buffer: Buffer };
    try {
      image = await fetchDiscordImageAttachment(input.file, {
        logger: this["logger"],
        maxBytes: DEFAULT_DISCORD_IMAGE_ATTACHMENT_MAX_BYTES,
        timeoutMs: DEFAULT_DISCORD_IMAGE_ATTACHMENT_TIMEOUT_MS,
      });
    } catch (err) {
      await safeReply(
        interaction,
        `读取图片失败：${err instanceof Error ? err.message : String(err)}`,
        { ephemeral: true },
      );
      return;
    }

    const saved = await this["worldFiles"].writeWorldImageAsset(meta.id, {
      name: assetName,
      sourceFilename: image.filename,
      uploaderId: interaction.user.id,
      contentType: image.contentType,
      bytes: image.buffer,
    });

    const sourceBlock = [
      `## 世界素材图：${saved.name}`,
      `- 时间：${saved.uploadedAt}`,
      `- 上传者：<@${interaction.user.id}>`,
      `- 文件：${saved.relativePath}`,
      `- 原文件名：${saved.sourceFilename}`,
      "",
      `- 引用路径：${saved.relativePath}`,
      "",
    ].join("\n");

    await this["worldFiles"].appendSourceDocument(meta.id, {
      filename: "world-image-assets.md",
      content: sourceBlock,
    });

    await this["worldFiles"].appendEvent(meta.id, {
      type: "world_image_uploaded",
      worldId: meta.id,
      userId: interaction.user.id,
      name: saved.name,
      filename: saved.filename,
      relativePath: saved.relativePath,
      sourceFilename: saved.sourceFilename,
      contentType: saved.contentType,
      sizeBytes: saved.sizeBytes,
    });

    await safeReply(
      interaction,
      [
        `已写入世界素材图：W${meta.id} ${meta.name}`,
        `- 名称：${saved.name}`,
        `- 文件：${saved.relativePath}`,
      ].join("\n"),
      { ephemeral: true },
    );
  };

  (
    DiscordAdapterClass.prototype as unknown as Record<string, unknown>
  ).handleWorldOpen = async function (
    this: DiscordAdapter,
    interaction: ChatInputCommandInteraction,
    worldId: number,
  ): Promise<void> {
    await safeDefer(interaction, { ephemeral: true });
    const language = await this["userState"]
      .getLanguage(interaction.user.id)
      .catch(() => null);
    const meta = await this["worldStore"].getWorld(worldId);
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

    await this["ensureWorldBuildGroupAgent"]({
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

    const workshop = await this["createCreatorOnlyChannel"]({
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
        await this["reopenPrivateThreadForUser"](fetched, interaction.user.id, {
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
      const thread = await this["tryCreatePrivateThread"]({
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
      await this["worldStore"].setWorldBuildChannelId({
        worldId: meta.id,
        channelId: buildConversationChannelId,
      });
      await this["worldStore"].setChannelWorldId(
        buildConversationChannelId,
        meta.id,
      );
      await this["worldFiles"].appendEvent(meta.id, {
        type: "world_build_thread_created",
        worldId: meta.id,
        guildId: interaction.guildId,
        userId: interaction.user.id,
        threadId: buildConversationChannelId,
        parentChannelId: thread.parentChannelId,
      });

      await this["sendWorldCreateRules"]({
        guildId: interaction.guildId,
        channelId: buildConversationChannelId,
        userId: interaction.user.id,
        worldId: meta.id,
        language,
      });
    }

    await this["worldStore"].setChannelGroupId(
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
  };

  (
    DiscordAdapterClass.prototype as unknown as Record<string, unknown>
  ).resolveWorldBuildDraftFromChannel = async function (
    this: DiscordAdapter,
    input: {
      channelId: string;
      expectedWorldId: number | null;
      requesterUserId: string;
      language: UserLanguage | null;
      requireCreator: boolean;
    },
  ): Promise<
    | {
        ok: true;
        worldId: number;
        meta: NonNullable<Awaited<ReturnType<WorldStore["getWorld"]>>>;
      }
    | { ok: false; message: string }
  > {
    const groupId = await this["worldStore"]
      .getGroupIdByChannel(input.channelId)
      .catch(() => null);
    const parsed = groupId ? parseWorldGroup(groupId) : null;
    if (!parsed || parsed.kind !== "build") {
      return {
        ok: false,
        message: pickByLanguage(
          input.language,
          "请先执行 /world create 或 /world open，然后在对应编辑话题执行该操作。",
          "Run /world create or /world open first, then run this inside the corresponding editing thread.",
        ),
      };
    }
    if (
      input.expectedWorldId !== null &&
      parsed.worldId !== input.expectedWorldId
    ) {
      return {
        ok: false,
        message: pickByLanguage(
          input.language,
          "该按钮与当前编辑话题不匹配（world_id 不一致）。",
          "This button does not match the current thread (world_id mismatch).",
        ),
      };
    }
    const meta = await this["worldStore"].getWorld(parsed.worldId);
    if (!meta) {
      return {
        ok: false,
        message: pickByLanguage(
          input.language,
          `世界不存在：W${parsed.worldId}`,
          `World not found: W${parsed.worldId}`,
        ),
      };
    }
    if (input.requireCreator && meta.creatorId !== input.requesterUserId) {
      return {
        ok: false,
        message: pickByLanguage(
          input.language,
          "无权限：只有世界创作者可以执行该操作。",
          "Permission denied: only the world creator can do this.",
        ),
      };
    }
    return { ok: true, worldId: parsed.worldId, meta };
  };

  (
    DiscordAdapterClass.prototype as unknown as Record<string, unknown>
  ).resolveCharacterBuildDraftFromChannel = async function (
    this: DiscordAdapter,
    input: {
      channelId: string;
      expectedCharacterId: number | null;
      requesterUserId: string;
      language: UserLanguage | null;
      requireCreator: boolean;
    },
  ): Promise<
    | {
        ok: true;
        characterId: number;
        meta: NonNullable<Awaited<ReturnType<WorldStore["getCharacter"]>>>;
      }
    | { ok: false; message: string }
  > {
    const groupId = await this["worldStore"]
      .getGroupIdByChannel(input.channelId)
      .catch(() => null);
    const parsed = groupId ? parseCharacterGroup(groupId) : null;
    if (!parsed || parsed.kind !== "build") {
      return {
        ok: false,
        message: pickByLanguage(
          input.language,
          "请先执行 /character create 或 /character open，然后在对应编辑话题执行该操作。",
          "Run /character create or /character open first, then run this inside the corresponding editing thread.",
        ),
      };
    }
    if (
      input.expectedCharacterId !== null &&
      parsed.characterId !== input.expectedCharacterId
    ) {
      return {
        ok: false,
        message: pickByLanguage(
          input.language,
          "该按钮与当前编辑话题不匹配（character_id 不一致）。",
          "This button does not match the current thread (character_id mismatch).",
        ),
      };
    }
    const meta = await this["worldStore"].getCharacter(parsed.characterId);
    if (!meta) {
      return {
        ok: false,
        message: pickByLanguage(
          input.language,
          `角色不存在：C${parsed.characterId}`,
          `Character not found: C${parsed.characterId}`,
        ),
      };
    }
    if (input.requireCreator && meta.creatorId !== input.requesterUserId) {
      return {
        ok: false,
        message: pickByLanguage(
          input.language,
          "无权限：只有角色创作者可以执行该操作。",
          "Permission denied: only the character creator can do this.",
        ),
      };
    }
    return { ok: true, characterId: parsed.characterId, meta };
  };

  (
    DiscordAdapterClass.prototype as unknown as Record<string, unknown>
  ).publishWorldFromBuildChannel = async function (
    this: DiscordAdapter,
    input: {
      channelId: string;
      requesterUserId: string;
      language: UserLanguage | null;
      showcaseCover?: Attachment;
    },
  ): Promise<string> {
    const resolved = await this["resolveWorldBuildDraftFromChannel"]({
      channelId: input.channelId,
      expectedWorldId: null,
      requesterUserId: input.requesterUserId,
      language: input.language,
      requireCreator: true,
    });
    if (!resolved.ok) {
      throw new LocalizedError({
        zh: resolved.message,
        en: resolved.message,
      });
    }
    const meta = resolved.meta;

    const resolveShowcaseCoverImage = async (): Promise<{
      image: WorldShowcaseCoverImage | null;
      warning: string | null;
    }> => {
      if (!input.showcaseCover) {
        return { image: null, warning: null };
      }
      try {
        const cover = await fetchDiscordImageAttachment(input.showcaseCover, {
          logger: this["logger"],
          maxBytes: DEFAULT_DISCORD_IMAGE_ATTACHMENT_MAX_BYTES,
          timeoutMs: DEFAULT_DISCORD_IMAGE_ATTACHMENT_TIMEOUT_MS,
        });
        return {
          image: {
            filename: cover.filename,
            buffer: cover.buffer,
          },
          warning: null,
        };
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        return {
          image: null,
          warning: pickByLanguage(
            input.language,
            `world-index 封面图读取失败，已忽略该图片：${detail}`,
            `world-index cover image failed to load and was skipped: ${detail}`,
          ),
        };
      }
    };

    if (meta.status !== "draft") {
      const notes: string[] = [];
      if (meta.status === "active") {
        const guild = await this["client"].guilds
          .fetch(meta.homeGuildId)
          .catch(() => null);
        if (!guild) {
          notes.push(
            pickByLanguage(
              input.language,
              "world-index 自动发帖失败：无法读取入口服务器。",
              "Failed to auto-post to world-index: entry guild unavailable.",
            ),
          );
        } else {
          const cover = await resolveShowcaseCoverImage();
          if (cover.warning) {
            notes.push(cover.warning);
          }
          try {
            const showcaseResult = await this["publishWorldShowcasePost"]({
              guild,
              worldId: meta.id,
              worldName: meta.name,
              creatorId: meta.creatorId,
              language: input.language,
              coverImage: cover.image,
            });
            if (showcaseResult.status === "created") {
              notes.push(
                pickByLanguage(
                  input.language,
                  `已补发 world-index：<#${showcaseResult.channelId}>`,
                  `Re-published to world-index: <#${showcaseResult.channelId}>`,
                ),
              );
            }
          } catch (err) {
            this["logger"].warn(
              { err, worldId: meta.id, guildId: meta.homeGuildId },
              "Failed to ensure world showcase post for published world",
            );
            notes.push(
              pickByLanguage(
                input.language,
                "world-index 自动发帖失败：请检查频道权限后重试。",
                "Failed to auto-post to world-index: please verify channel permissions and retry.",
              ),
            );
          }
        }
      }

      const base = pickByLanguage(
        input.language,
        `世界已发布：W${meta.id} ${meta.name}（status=${meta.status}）`,
        `World already published: W${meta.id} ${meta.name} (status=${meta.status})`,
      );
      return notes.length > 0 ? `${base}\n${notes.join("\n")}` : base;
    }

    const guild = await this["client"].guilds
      .fetch(meta.homeGuildId)
      .catch(() => null);
    if (!guild) {
      throw new LocalizedError({
        zh: pickByLanguage(
          input.language,
          `无法获取世界入口服务器：guild:${meta.homeGuildId}`,
          `Failed to fetch the world's entry server: guild:${meta.homeGuildId}`,
        ),
        en: pickByLanguage(
          input.language,
          `无法获取世界入口服务器：guild:${meta.homeGuildId}`,
          `Failed to fetch the world's entry server: guild:${meta.homeGuildId}`,
        ),
      });
    }

    const card = await this["worldFiles"].readWorldCard(meta.id);
    const extractedWorldName = extractWorldNameFromCard(card);
    const worldName = extractedWorldName?.trim() || meta.name;
    if (extractedWorldName && extractedWorldName.trim() !== meta.name) {
      await this["worldStore"]
        .setWorldName({ worldId: meta.id, name: extractedWorldName.trim() })
        .catch(() => {});
    }

    const created = await this["createWorldSubspace"]({
      guild,
      worldId: meta.id,
      worldName,
      creatorUserId: meta.creatorId,
    });

    await this["worldStore"].publishWorld({
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
      forumChannelId: created.forumChannelId,
      proposalsChannelId: created.proposalsChannelId,
      voiceChannelId: created.voiceChannelId,
    });

    await this["ensureWorldGroupAgent"]({
      worldId: meta.id,
      worldName,
      language: input.language,
    });

    try {
      const member = await guild.members.fetch(meta.creatorId);
      await member.roles.add(created.roleId, "world creator auto-join");
    } catch {
      // ignore
    }
    await this["worldStore"]
      .addMember(meta.id, meta.creatorId)
      .catch(() => false);
    await this["worldFiles"]
      .ensureMember(meta.id, meta.creatorId)
      .catch(() => {});

    await this["pushWorldInfoSnapshot"]({
      guildId: meta.homeGuildId,
      worldId: meta.id,
      worldName,
      infoChannelId: created.infoChannelId,
    });

    void this["publishWorldFunctionalGuides"]({
      guildId: meta.homeGuildId,
      worldId: meta.id,
      worldName,
      discussionChannelId: created.discussionChannelId,
      forumChannelId: created.forumChannelId,
      proposalsChannelId: created.proposalsChannelId,
    }).catch((err) => {
      this["logger"].warn(
        { err, worldId: meta.id, guildId: meta.homeGuildId },
        "Failed to publish world functional guides",
      );
    });

    const publishNotes: string[] = [];
    const cover = await resolveShowcaseCoverImage();
    if (cover.warning) {
      publishNotes.push(cover.warning);
    }

    try {
      const showcaseResult = await this["publishWorldShowcasePost"]({
        guild,
        worldId: meta.id,
        worldName,
        creatorId: meta.creatorId,
        language: input.language,
        coverImage: cover.image,
      });
      publishNotes.push(
        pickByLanguage(
          input.language,
          `索引：<#${showcaseResult.channelId}>`,
          `Index: <#${showcaseResult.channelId}>`,
        ),
      );
    } catch (err) {
      this["logger"].warn(
        { err, worldId: meta.id, guildId: meta.homeGuildId },
        "Failed to publish world showcase post",
      );
      publishNotes.push(
        pickByLanguage(
          input.language,
          "world-index 自动发帖失败：请检查频道权限后重试。",
          "Failed to auto-post to world-index: please verify channel permissions and retry.",
        ),
      );
    }

    const base = pickByLanguage(
      input.language,
      [
        `世界已发布：W${meta.id} ${worldName}`,
        `公告：<#${created.infoChannelId}>`,
        `讨论：<#${created.discussionChannelId}>`,
        `论坛：<#${created.forumChannelId}>`,
        `提案：<#${created.proposalsChannelId}>`,
        `加入：/world join world_id:${meta.id}`,
      ].join("\n"),
      [
        `World published: W${meta.id} ${worldName}`,
        `Announcements: <#${created.infoChannelId}>`,
        `Discussion: <#${created.discussionChannelId}>`,
        `Forum: <#${created.forumChannelId}>`,
        `Proposals: <#${created.proposalsChannelId}>`,
        `Join: /world join world_id:${meta.id}`,
      ].join("\n"),
    );
    return publishNotes.length > 0
      ? `${base}\n${publishNotes.join("\n")}`
      : base;
  };

  (
    DiscordAdapterClass.prototype as unknown as Record<string, unknown>
  ).publishWorldFunctionalGuides = async function (
    this: DiscordAdapter,
    input: {
      guildId: string;
      worldId: number;
      worldName: string;
      discussionChannelId: string;
      forumChannelId: string;
      proposalsChannelId: string;
    },
  ): Promise<void> {
    await this["sendLongTextToChannel"]({
      guildId: input.guildId,
      channelId: input.discussionChannelId,
      content: buildWorldDiscussionGuide({
        worldId: input.worldId,
        worldName: input.worldName,
        forumChannelId: input.forumChannelId,
      }),
    });

    await this["sendLongTextToChannel"]({
      guildId: input.guildId,
      channelId: input.proposalsChannelId,
      content: buildWorldProposalsGuide({
        worldId: input.worldId,
        worldName: input.worldName,
      }),
    });
  };

  (
    DiscordAdapterClass.prototype as unknown as Record<string, unknown>
  ).handleWorldPublish = async function (
    this: DiscordAdapter,
    interaction: ChatInputCommandInteraction,
    input?: { cover?: Attachment },
  ): Promise<void> {
    const language = await this["userState"]
      .getLanguage(interaction.user.id)
      .catch(() => null);
    await safeDefer(interaction, { ephemeral: true });
    try {
      const message = await this["publishWorldFromBuildChannel"]({
        channelId: interaction.channelId,
        requesterUserId: interaction.user.id,
        language,
        showcaseCover: input?.cover,
      });
      await safeReply(interaction, message, { ephemeral: true });
    } catch (err) {
      await safeReply(
        interaction,
        resolveUserMessageFromError(language, err, {
          zh: `发布失败：${err instanceof Error ? err.message : String(err)}`,
          en: `Failed: ${err instanceof Error ? err.message : String(err)}`,
        }),
        { ephemeral: true },
      );
    }
  };

  (
    DiscordAdapterClass.prototype as unknown as Record<string, unknown>
  ).handleWorldList = async function (
    this: DiscordAdapter,
    interaction: ChatInputCommandInteraction,
  ): Promise<void> {
    const language = await this["userState"]
      .getLanguage(interaction.user.id)
      .catch(() => null);
    await safeDefer(interaction, { ephemeral: false });
    const limit = interaction.options.getInteger("limit") ?? 20;
    const ids = await this["worldStore"].listWorldIds(limit);
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
      active.map((meta) => this["worldFiles"].readWorldCard(meta.id)),
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
  };

  (
    DiscordAdapterClass.prototype as unknown as Record<string, unknown>
  ).handleWorldInfo = async function (
    this: DiscordAdapter,
    interaction: ChatInputCommandInteraction,
    worldId: number,
  ): Promise<void> {
    const language = await this["userState"]
      .getLanguage(interaction.user.id)
      .catch(() => null);
    await safeDefer(interaction, { ephemeral: false });
    const meta = await this["worldStore"].getWorld(worldId);
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
    const card = await this["worldFiles"].readWorldCard(meta.id);
    const stats = await this["worldFiles"].readStats(meta.id);
    const creatorLabel = await this["resolveDiscordUserLabel"]({
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
              meta.forumChannelId ? `论坛：<#${meta.forumChannelId}>` : null,
              `提案：<#${meta.proposalsChannelId}>`,
              `加入：\`/world join world_id:${meta.id}\``,
            ]
              .filter((line): line is string => Boolean(line))
              .join("\n"),
            [
              `Announcements: <#${meta.infoChannelId}>`,
              `Discussion: <#${meta.roleplayChannelId}>`,
              meta.forumChannelId ? `Forum: <#${meta.forumChannelId}>` : null,
              `Proposals: <#${meta.proposalsChannelId}>`,
              `Join: \`/world join world_id:${meta.id}\``,
            ]
              .filter((line): line is string => Boolean(line))
              .join("\n"),
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
  };

  (
    DiscordAdapterClass.prototype as unknown as Record<string, unknown>
  ).handleWorldRules = async function (
    this: DiscordAdapter,
    interaction: ChatInputCommandInteraction,
    worldId: number,
  ): Promise<void> {
    const language = await this["userState"]
      .getLanguage(interaction.user.id)
      .catch(() => null);
    await safeDefer(interaction, { ephemeral: false });
    const meta = await this["worldStore"].getWorld(worldId);
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
    const rules = await this["worldFiles"].readRules(meta.id);
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
  };

  (
    DiscordAdapterClass.prototype as unknown as Record<string, unknown>
  ).handleWorldCanon = async function (
    this: DiscordAdapter,
    interaction: ChatInputCommandInteraction,
    input: { query: string; worldId?: number },
  ): Promise<void> {
    const query = input.query.trim();
    if (!query) {
      await safeReply(interaction, "query 不能为空。", { ephemeral: false });
      return;
    }

    const inferredWorldId = interaction.channelId
      ? await this["worldStore"].getWorldIdByChannel(interaction.channelId)
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
        { ephemeral: false },
      );
      return;
    }

    const lowered = query.toLowerCase();
    const [card, rules, chronicle, tasks, news, canon] = await Promise.all([
      this["worldFiles"].readWorldCard(meta.id),
      this["worldFiles"].readRules(meta.id),
      this["worldFiles"].readCanon(meta.id, "chronicle.md"),
      this["worldFiles"].readCanon(meta.id, "tasks.md"),
      this["worldFiles"].readCanon(meta.id, "news.md"),
      this["worldFiles"].readCanon(meta.id, "canon.md"),
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
  };

  (
    DiscordAdapterClass.prototype as unknown as Record<string, unknown>
  ).handleWorldSubmit = async function (
    this: DiscordAdapter,
    interaction: ChatInputCommandInteraction,
    input: {
      worldId: number;
      kind: "canon" | "chronicle" | "task" | "news";
      title: string;
      content: string;
    },
  ): Promise<void> {
    const meta = await this["worldStore"].getWorld(input.worldId);
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

    const submissionId = await this["worldStore"].nextWorldSubmissionId(
      meta.id,
    );
    const nowIso = new Date().toISOString();
    const language = await this["userState"]
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

    await this["worldFiles"].writeSubmission(
      meta.id,
      "pending",
      submissionId,
      payload,
    );
    await this["worldFiles"].appendEvent(meta.id, {
      type: "world_submission_created",
      worldId: meta.id,
      submissionId,
      kind: input.kind,
      title: input.title,
      userId: interaction.user.id,
    });

    if (meta.status === "active") {
      await this["sendLongTextToChannel"]({
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
  };

  (
    DiscordAdapterClass.prototype as unknown as Record<string, unknown>
  ).handleWorldApprove = async function (
    this: DiscordAdapter,
    interaction: ChatInputCommandInteraction,
    input: { worldId: number; submissionId: number },
  ): Promise<void> {
    const meta = await this["worldStore"].getWorld(input.worldId);
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

    const pending = await this["worldFiles"].readSubmission(
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

    const moved = await this["worldFiles"].moveSubmission({
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
    await this["worldFiles"].appendCanon(
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

    await this["worldFiles"].appendEvent(meta.id, {
      type: "world_submission_approved",
      worldId: meta.id,
      submissionId: input.submissionId,
      kind,
      title,
      approverUserId: interaction.user.id,
    });

    await this["sendLongTextToChannel"]({
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
  };

  (
    DiscordAdapterClass.prototype as unknown as Record<string, unknown>
  ).handleWorldCheck = async function (
    this: DiscordAdapter,
    interaction: ChatInputCommandInteraction,
    input: { worldId: number; query: string },
  ): Promise<void> {
    const query = input.query.trim();
    if (!query) {
      await safeReply(interaction, "query 不能为空。", { ephemeral: true });
      return;
    }

    const meta = await this["worldStore"].getWorld(input.worldId);
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
      this["worldFiles"].readWorldCard(meta.id),
      this["worldFiles"].readRules(meta.id),
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
      const content = await this["worldFiles"].readCanon(meta.id, filename);
      if (content?.toLowerCase().includes(lowered)) {
        hits.push(`canon/${filename}`);
      }
    }

    const pendingIds = await this["worldFiles"].listSubmissionIds(
      meta.id,
      "pending",
      50,
    );
    for (const id of pendingIds) {
      const content = await this["worldFiles"].readSubmission(
        meta.id,
        "pending",
        id,
      );
      if (content?.toLowerCase().includes(lowered)) {
        hits.push(`submissions/pending/${id}.md`);
      }
    }
    const approvedIds = await this["worldFiles"].listSubmissionIds(
      meta.id,
      "approved",
      50,
    );
    for (const id of approvedIds) {
      const content = await this["worldFiles"].readSubmission(
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
  };
}
