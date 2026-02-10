import type { DiscordAdapter } from "./adapter";
import { feishuLogJson } from "../../feishu/webhook";
import { createTraceId } from "../../telemetry";
import {
  buildDiscordWorldHelp,
  buildWorldSourceSeedContent,
} from "../../texts";
import type { SessionEvent } from "../../types/platform";
import type { UserLanguage } from "../../user/state-store";
import { buildWorldBuildGroupId } from "../../world/ids";
import type { WorldActiveMeta } from "../../world/store";
import {
  LocalizedError,
  pickByLanguage,
  resolveUserMessageFromError,
} from "./adapter-internals";
import {
  extractCharacterNameFromCard,
  extractWorldNameFromCard,
  truncateDiscordLabel,
} from "./card-parsers";
import { patchCreatorLineInMarkdown } from "./character-card-variants";
import { safeDefer, safeReply, safeReplyRich } from "./interaction-helpers";
import {
  buildMarkdownCardEmbeds,
  chunkEmbedsForDiscord,
} from "./markdown-cards";
import { buildOnboardingCustomId } from "./onboarding-custom-id";
import {
  ActionRowBuilder,
  APIEmbed,
  ButtonBuilder,
  ButtonStyle,
  ChatInputCommandInteraction,
  Guild,
  MessageCreateOptions,
  StringSelectMenuBuilder,
} from "discord.js";

export function installDiscordAdapterOnboardingWorldEntry(DiscordAdapterClass: {
  prototype: DiscordAdapter;
}): void {
  (
    DiscordAdapterClass.prototype as unknown as Record<string, unknown>
  ).sendWorldCardToChannel = async function (
    this: DiscordAdapter,
    input: {
      guildId: string;
      channelId: string;
      requesterUserId: string;
      language: UserLanguage | null;
      worldId: number;
      guild: Guild;
    },
  ): Promise<void> {
    const meta = await this["worldStore"].getWorld(input.worldId);
    if (!meta) {
      await this["sendRichToChannel"]({
        guildId: input.guildId,
        channelId: input.channelId,
        content: pickByLanguage(
          input.language,
          `世界不存在：W${input.worldId}`,
          `World not found: W${input.worldId}`,
        ),
      });
      return;
    }
    const allowed =
      meta.status !== "draft" || meta.creatorId === input.requesterUserId;
    if (!allowed) {
      await this["sendRichToChannel"]({
        guildId: input.guildId,
        channelId: input.channelId,
        content: pickByLanguage(
          input.language,
          "无权限：只有世界创作者可以查看草稿。",
          "Permission denied: only the world creator can view this draft.",
        ),
      });
      return;
    }

    const card = await this["worldFiles"].readWorldCard(meta.id);
    const creatorLabel = await this["resolveDiscordUserLabel"]({
      userId: meta.creatorId,
      guild: input.guildId === meta.homeGuildId ? input.guild : null,
    });
    const patchedCard =
      card?.trim() && meta.creatorId
        ? patchCreatorLineInMarkdown(card.trim(), meta.creatorId, creatorLabel)
        : card?.trim()
          ? card.trim()
          : "";

    if (!patchedCard) {
      await this["sendRichToChannel"]({
        guildId: input.guildId,
        channelId: input.channelId,
        content: pickByLanguage(
          input.language,
          "世界卡为空（可能仍在生成中）。请稍后重试。",
          "World card is empty (it may still be generating). Please retry later.",
        ),
      });
      return;
    }

    const embeds: APIEmbed[] = [
      {
        title: `W${meta.id} ${meta.name}`,
        fields: [
          {
            name: pickByLanguage(input.language, "创作者", "Creator"),
            value: creatorLabel || `<@${meta.creatorId}>`,
            inline: true,
          },
          {
            name: pickByLanguage(input.language, "状态", "Status"),
            value: meta.status,
            inline: true,
          },
          {
            name: pickByLanguage(input.language, "入口", "Entry"),
            value: `guild:${meta.homeGuildId}`,
            inline: true,
          },
        ],
      },
      ...buildMarkdownCardEmbeds(patchedCard, {
        titlePrefix: pickByLanguage(input.language, "世界卡", "World Card"),
        maxEmbeds: 18,
        includeEmptyFields: true,
      }),
    ];

    for (const chunk of chunkEmbedsForDiscord(embeds, 10)) {
      await this["sendRichToChannel"]({
        guildId: input.guildId,
        channelId: input.channelId,
        embeds: chunk,
      });
    }

    const components: MessageCreateOptions["components"] = [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(
            buildOnboardingCustomId({
              userId: input.requesterUserId,
              action: "menu",
            }),
          )
          .setLabel(input.language === "en" ? "Back to Menu" : "回到菜单")
          .setStyle(ButtonStyle.Secondary),
      ),
    ];
    await this["sendRichToChannel"]({
      guildId: input.guildId,
      channelId: input.channelId,
      embeds: [
        {
          title: pickByLanguage(input.language, "下一步", "Next"),
          description: pickByLanguage(
            input.language,
            "继续完善设定后，在编辑话题里用 /world publish 发布。",
            "After finishing lore, run /world publish in the editing thread.",
          ),
        },
      ],
      components,
    });
  };

  (
    DiscordAdapterClass.prototype as unknown as Record<string, unknown>
  ).sendOnboardingWorldJoinCharacterPicker = async function (
    this: DiscordAdapter,
    input: {
      guildId: string;
      channelId: string;
      userId: string;
      language: UserLanguage | null;
      worldId: number;
      worldName: string;
      characterIds: number[];
    },
  ): Promise<void> {
    const worldCard = await this["worldFiles"]
      .readWorldCard(input.worldId)
      .catch(() => null);
    const worldDisplayName =
      extractWorldNameFromCard(worldCard)?.trim() ||
      input.worldName?.trim() ||
      `World-${input.worldId}`;

    const metas = await Promise.all(
      input.characterIds.map((id) => this["worldStore"].getCharacter(id)),
    );
    const candidates: Array<{
      id: number;
      name: string;
      visibility: string;
      status: string;
    }> = [];
    for (const meta of metas) {
      if (!meta) {
        continue;
      }
      if (meta.creatorId !== input.userId) {
        continue;
      }
      candidates.push({
        id: meta.id,
        name: meta.name,
        visibility: meta.visibility,
        status: meta.status,
      });
    }

    const withDisplayName = await Promise.all(
      candidates.map(async (meta) => {
        const card = await this["worldFiles"]
          .readCharacterCard(meta.id)
          .catch(() => null);
        const displayName =
          extractCharacterNameFromCard(card)?.trim() ||
          meta.name?.trim() ||
          `Character-${meta.id}`;
        return { ...meta, displayName };
      }),
    );

    const options = withDisplayName.slice(0, 25).map((meta) => ({
      label: truncateDiscordLabel(`C${meta.id} ${meta.displayName}`, 100),
      description: truncateDiscordLabel(
        input.language === "en"
          ? `visibility ${meta.visibility}, status ${meta.status}`
          : `可见性${meta.visibility} 状态${meta.status}`,
        100,
      ),
      value: String(meta.id),
    }));

    if (options.length === 0) {
      await this["sendRichToChannel"]({
        guildId: input.guildId,
        channelId: input.channelId,
        content: pickByLanguage(
          input.language,
          "你还没有可用的角色卡：请先创建角色。",
          "No available character. Please create one first.",
        ),
      });
      return;
    }

    const menu = new StringSelectMenuBuilder()
      .setCustomId(
        buildOnboardingCustomId({
          userId: input.userId,
          action: "world_join",
          payload: String(input.worldId),
        }),
      )
      .setPlaceholder(
        input.language === "en" ? "Pick a character…" : "选择要使用的角色…",
      )
      .addOptions(options);

    const embeds: APIEmbed[] = [
      {
        title:
          input.language === "en" ? "Pick a Character" : "选择要使用的角色",
        description:
          input.language === "en"
            ? [
                `World: W${input.worldId} ${worldDisplayName}`,
                "",
                "You have multiple characters. Pick one to join this world.",
              ].join("\n")
            : [
                `目标世界：W${input.worldId} ${worldDisplayName}`,
                "",
                "你有多个角色，请先选一个用于加入世界。",
              ].join("\n"),
      },
    ];

    const components: MessageCreateOptions["components"] = [
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu),
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(
            buildOnboardingCustomId({
              userId: input.userId,
              action: "character_create",
            }),
          )
          .setLabel(input.language === "en" ? "New Character" : "创建新角色")
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId(
            buildOnboardingCustomId({
              userId: input.userId,
              action: "menu",
            }),
          )
          .setLabel(input.language === "en" ? "Back" : "返回菜单")
          .setStyle(ButtonStyle.Secondary),
      ),
    ];

    await this["sendRichToChannel"]({
      guildId: input.guildId,
      channelId: input.channelId,
      embeds,
      components,
    });
  };

  (
    DiscordAdapterClass.prototype as unknown as Record<string, unknown>
  ).sendOnboardingWorldList = async function (
    this: DiscordAdapter,
    input: {
      guildId: string;
      channelId: string;
      userId: string;
      language: UserLanguage | null;
    },
  ): Promise<void> {
    const ids = await this["worldStore"].listWorldIds(50);
    const metas = await Promise.all(
      ids.map((id) => this["worldStore"].getWorld(id)),
    );
    const active = metas.filter((meta): meta is WorldActiveMeta =>
      Boolean(meta && meta.status === "active"),
    );

    const withStats = await Promise.all(
      active.map(async (meta) => ({
        meta,
        displayName:
          extractWorldNameFromCard(
            await this["worldFiles"].readWorldCard(meta.id).catch(() => null),
          )?.trim() ||
          meta.name?.trim() ||
          `World-${meta.id}`,
        stats: await this["worldFiles"].readStats(meta.id),
      })),
    );
    withStats.sort((a, b) => {
      const diff = b.stats.visitorCount - a.stats.visitorCount;
      if (diff !== 0) return diff;
      return b.meta.id - a.meta.id;
    });

    const top = withStats.slice(0, 3);
    const lines =
      top.length > 0
        ? top.map(
            ({ meta, displayName, stats }) =>
              `- W${meta.id} ${displayName}（访客${stats.visitorCount} 角色${stats.characterCount}）`,
          )
        : [];
    const embeds: APIEmbed[] = [
      {
        title: input.language === "en" ? "Pick a World" : "选择一个世界",
        description:
          top.length > 0
            ? input.language === "en"
              ? [
                  "Top worlds:",
                  ...top.map(
                    ({ meta, displayName, stats }) =>
                      `- W${meta.id} ${displayName} (visitors ${stats.visitorCount}, chars ${stats.characterCount})`,
                  ),
                ].join("\n")
              : ["热门世界：", ...lines].join("\n")
            : input.language === "en"
              ? "No active worlds yet."
              : "暂无已发布世界。",
      },
    ];

    const joinButtonsRow =
      top.length > 0
        ? (() => {
            const buttons = new ActionRowBuilder<ButtonBuilder>();
            for (const entry of top) {
              buttons.addComponents(
                new ButtonBuilder()
                  .setCustomId(
                    buildOnboardingCustomId({
                      userId: input.userId,
                      action: "world_join",
                      payload: String(entry.meta.id),
                    }),
                  )
                  .setLabel(
                    truncateDiscordLabel(
                      `W${entry.meta.id} ${entry.displayName}`,
                      80,
                    ),
                  )
                  .setStyle(ButtonStyle.Primary),
              );
            }
            return buttons;
          })()
        : null;

    const selectRow =
      withStats.length > 3
        ? (() => {
            const options = withStats
              .slice(0, 25)
              .map(({ meta, displayName, stats }) => ({
                label: truncateDiscordLabel(`W${meta.id} ${displayName}`, 100),
                description: truncateDiscordLabel(
                  input.language === "en"
                    ? `visitors ${stats.visitorCount}, chars ${stats.characterCount}`
                    : `访客${stats.visitorCount} 角色${stats.characterCount}`,
                  100,
                ),
                value: String(meta.id),
              }));
            const menu = new StringSelectMenuBuilder()
              .setCustomId(
                buildOnboardingCustomId({
                  userId: input.userId,
                  action: "world_select",
                }),
              )
              .setPlaceholder(
                input.language === "en" ? "More worlds…" : "更多世界…",
              )
              .addOptions(options);
            return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
              menu,
            );
          })()
        : null;

    const backRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(
          buildOnboardingCustomId({
            userId: input.userId,
            action: "menu",
          }),
        )
        .setLabel(input.language === "en" ? "Back" : "返回菜单")
        .setStyle(ButtonStyle.Secondary),
    );

    const components: MessageCreateOptions["components"] = [
      ...(joinButtonsRow ? [joinButtonsRow] : []),
      ...(selectRow ? [selectRow] : []),
      backRow,
    ];

    await this["sendRichToChannel"]({
      guildId: input.guildId,
      channelId: input.channelId,
      embeds,
      components,
    });
  };

  (
    DiscordAdapterClass.prototype as unknown as Record<string, unknown>
  ).handleOnboardingWorldJoin = async function (
    this: DiscordAdapter,
    input: {
      guildId: string;
      guild: Guild;
      channelId: string;
      userId: string;
      language: UserLanguage | null;
      worldId: number;
      explicitCharacterId?: number;
    },
  ): Promise<void> {
    try {
      const worldMeta = await this["worldStore"].getWorld(input.worldId);
      if (!worldMeta) {
        throw new LocalizedError({
          zh: `世界不存在：W${input.worldId}`,
          en: `World not found: W${input.worldId}`,
        });
      }
      if (worldMeta.status !== "active") {
        throw new LocalizedError({
          zh: `无法加入：世界尚未发布（W${worldMeta.id} 当前状态=${worldMeta.status}）`,
          en: `Cannot join: world is not published yet (W${worldMeta.id} status=${worldMeta.status})`,
        });
      }
      if (input.guildId !== worldMeta.homeGuildId) {
        throw new LocalizedError({
          zh: `无法加入：该世界入口在 guild:${worldMeta.homeGuildId}（请先加入该服务器后再加入世界）。`,
          en: `Cannot join: this world's entry server is guild:${worldMeta.homeGuildId} (join that server first).`,
        });
      }

      let explicitCharacterId = input.explicitCharacterId;
      if (
        !(
          explicitCharacterId &&
          Number.isInteger(explicitCharacterId) &&
          explicitCharacterId > 0
        )
      ) {
        explicitCharacterId = undefined;
      }

      if (!explicitCharacterId) {
        try {
          explicitCharacterId = await this["resolveJoinCharacterId"]({
            userId: input.userId,
          });
        } catch (err) {
          const candidateIds = await this["worldStore"].listUserCharacterIds(
            input.userId,
            25,
          );
          if (candidateIds.length > 1) {
            await this["sendOnboardingWorldJoinCharacterPicker"]({
              guildId: input.guildId,
              channelId: input.channelId,
              userId: input.userId,
              language: input.language,
              worldId: worldMeta.id,
              worldName: worldMeta.name,
              characterIds: candidateIds,
            });
            return;
          }
          throw err;
        }
      }

      const joined = await this["joinWorldForUser"]({
        guildId: input.guildId,
        guild: input.guild,
        userId: input.userId,
        worldId: input.worldId,
        language: input.language,
        explicitCharacterId,
      });
      await this["sendOnboardingAfterWorldJoin"]({
        guildId: input.guildId,
        channelId: input.channelId,
        userId: input.userId,
        language: input.language,
        worldId: joined.worldId,
        worldName: joined.worldName,
        roleplayChannelId: joined.roleplayChannelId,
        characterId: joined.characterId,
        characterName: joined.characterName,
        forked: joined.forked,
      });
    } catch (err) {
      const msg = resolveUserMessageFromError(input.language, err, {
        zh: `加入失败：${err instanceof Error ? err.message : String(err)}`,
        en: `Failed to join: ${err instanceof Error ? err.message : String(err)}`,
      }).trim();

      const embeds: APIEmbed[] = [
        {
          title: input.language === "en" ? "Join Failed" : "加入失败",
          description: msg,
        },
      ];
      const components: MessageCreateOptions["components"] = [
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder()
            .setCustomId(
              buildOnboardingCustomId({
                userId: input.userId,
                action: "character_create",
              }),
            )
            .setLabel(
              input.language === "en" ? "Create Character" : "创建角色卡",
            )
            .setStyle(ButtonStyle.Primary),
          new ButtonBuilder()
            .setCustomId(
              buildOnboardingCustomId({
                userId: input.userId,
                action: "menu",
              }),
            )
            .setLabel(input.language === "en" ? "Back" : "返回菜单")
            .setStyle(ButtonStyle.Secondary),
        ),
      ];

      await this["sendRichToChannel"]({
        guildId: input.guildId,
        channelId: input.channelId,
        embeds,
        components,
      });
    }
  };

  (
    DiscordAdapterClass.prototype as unknown as Record<string, unknown>
  ).sendOnboardingAfterWorldJoin = async function (
    this: DiscordAdapter,
    input: {
      guildId: string;
      channelId: string;
      userId: string;
      language: UserLanguage | null;
      worldId: number;
      worldName: string;
      roleplayChannelId: string;
      characterId: number;
      characterName: string;
      forked: boolean;
    },
  ): Promise<void> {
    const embeds: APIEmbed[] = [
      {
        title:
          input.language === "en"
            ? "Step 2: Joined World"
            : "第 2 步：已加入世界",
        description:
          input.language === "en"
            ? [
                `W${input.worldId} ${input.worldName}`,
                `Go to: <#${input.roleplayChannelId}>`,
                `Active character: C${input.characterId} ${input.characterName}${
                  input.forked ? " (world-specific fork)" : ""
                }`,
              ].join("\n")
            : [
                `W${input.worldId} ${input.worldName}`,
                `去这里开始：<#${input.roleplayChannelId}>`,
                `当前角色：C${input.characterId} ${input.characterName}${
                  input.forked ? "（本世界专用）" : ""
                }`,
              ].join("\n"),
      },
    ];

    const components: MessageCreateOptions["components"] = [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(
            buildOnboardingCustomId({
              userId: input.userId,
              action: "world_show",
              payload: String(input.worldId),
            }),
          )
          .setLabel(input.language === "en" ? "View World Card" : "查看世界卡")
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId(
            buildOnboardingCustomId({
              userId: input.userId,
              action: "menu",
            }),
          )
          .setLabel(input.language === "en" ? "Back to Menu" : "回到菜单")
          .setStyle(ButtonStyle.Secondary),
      ),
    ];

    await this["sendRichToChannel"]({
      guildId: input.guildId,
      channelId: input.channelId,
      embeds,
      components,
    });
  };

  (
    DiscordAdapterClass.prototype as unknown as Record<string, unknown>
  ).sendOnboardingAfterWorldCreate = async function (
    this: DiscordAdapter,
    input: {
      guildId: string;
      channelId: string;
      userId: string;
      language: UserLanguage | null;
      worldId: number;
      worldName: string;
      buildChannelId: string;
    },
  ): Promise<void> {
    const embeds: APIEmbed[] = [
      {
        title:
          input.language === "en" ? "World Draft Created" : "世界草稿已创建",
        description:
          input.language === "en"
            ? [
                `W${input.worldId} ${input.worldName}`,
                `Continue editing here: <#${input.buildChannelId}>`,
                "",
                "Paste/upload your lore, then publish when ready.",
              ].join("\n")
            : [
                `W${input.worldId} ${input.worldName}`,
                `去这里继续：<#${input.buildChannelId}>`,
                "",
                "在编辑话题粘贴/上传设定，整理完确认无误后发布。",
              ].join("\n"),
      },
    ];
    const components: MessageCreateOptions["components"] = [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(
            buildOnboardingCustomId({
              userId: input.userId,
              action: "menu",
            }),
          )
          .setLabel(input.language === "en" ? "Back to Menu" : "回到菜单")
          .setStyle(ButtonStyle.Secondary),
      ),
    ];

    await this["sendRichToChannel"]({
      guildId: input.guildId,
      channelId: input.channelId,
      embeds,
      components,
    });
  };

  (
    DiscordAdapterClass.prototype as unknown as Record<string, unknown>
  ).rememberPendingInteractionReply = function (
    this: DiscordAdapter,
    interaction: ChatInputCommandInteraction,
  ): void {
    const now = Date.now();
    this["pendingInteractionReplies"].set(interaction.id, {
      interaction,
      createdAtMs: now,
    });
    if (this["pendingInteractionReplies"].size <= 200) {
      return;
    }
    for (const [interactionId, entry] of this["pendingInteractionReplies"]) {
      if (now - entry.createdAtMs > 15 * 60 * 1000) {
        this["pendingInteractionReplies"].delete(interactionId);
      }
    }
  };

  (
    DiscordAdapterClass.prototype as unknown as Record<string, unknown>
  ).takePendingInteractionReply = function (
    this: DiscordAdapter,
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

    const entry = this["pendingInteractionReplies"].get(interactionId);
    if (!entry) {
      return null;
    }
    this["pendingInteractionReplies"].delete(interactionId);
    if (Date.now() - entry.createdAtMs > 15 * 60 * 1000) {
      return null;
    }
    return entry.interaction;
  };

  (
    DiscordAdapterClass.prototype as unknown as Record<string, unknown>
  ).handleLanguage = async function (
    this: DiscordAdapter,
    interaction: ChatInputCommandInteraction,
  ): Promise<void> {
    await safeDefer(interaction, { ephemeral: true });
    const langRaw = interaction.options.getString("lang", true);
    const language = langRaw === "en" ? "en" : "zh";
    await this["userState"].setLanguage(interaction.user.id, language);
    await safeReply(
      interaction,
      language === "en"
        ? `Language set: ${language}`
        : `已设置语言：${language}`,
      { ephemeral: true },
    );
  };

  (
    DiscordAdapterClass.prototype as unknown as Record<string, unknown>
  ).handleWorldCommand = async function (
    this: DiscordAdapter,
    interaction: ChatInputCommandInteraction,
    flags: { isGuildOwner: boolean; isGuildAdmin: boolean },
  ): Promise<void> {
    const subcommand = interaction.options.getSubcommand();
    if (subcommand === "create") {
      await this["handleWorldCreate"](interaction, flags);
      return;
    }
    if (subcommand === "help") {
      await this["handleWorldHelp"](interaction);
      return;
    }
    if (subcommand === "open") {
      const worldId = interaction.options.getInteger("world_id", true);
      await this["handleWorldOpen"](interaction, worldId);
      return;
    }
    if (subcommand === "publish") {
      const cover = interaction.options.getAttachment("cover") ?? undefined;
      await this["handleWorldPublish"](interaction, { cover });
      return;
    }
    if (subcommand === "export") {
      const worldId = interaction.options.getInteger("world_id") ?? undefined;
      await this["handleWorldExport"](interaction, { worldId });
      return;
    }
    if (subcommand === "import") {
      const kind = interaction.options.getString("kind", true);
      const file = interaction.options.getAttachment("file", true);
      const worldId = interaction.options.getInteger("world_id") ?? undefined;
      await this["handleWorldImport"](interaction, { kind, file, worldId });
      return;
    }
    if (subcommand === "image") {
      const name = interaction.options.getString("name", true);
      const file = interaction.options.getAttachment("file", true);
      const worldId = interaction.options.getInteger("world_id") ?? undefined;
      await this["handleWorldImageUpload"](interaction, {
        name,
        file,
        worldId,
      });
      return;
    }
    if (subcommand === "list") {
      await this["handleWorldList"](interaction);
      return;
    }
    if (subcommand === "info") {
      const worldId =
        interaction.options.getInteger("world_id") ??
        (await this["inferWorldIdFromWorldSubspace"](interaction).catch(
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
      await this["handleWorldInfo"](interaction, worldId);
      return;
    }
    if (subcommand === "rules") {
      const worldId =
        interaction.options.getInteger("world_id") ??
        (await this["inferWorldIdFromWorldSubspace"](interaction).catch(
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
      await this["handleWorldRules"](interaction, worldId);
      return;
    }
    if (subcommand === "canon") {
      const query = interaction.options.getString("query", true);
      const worldId = interaction.options.getInteger("world_id") ?? undefined;
      await this["handleWorldCanon"](interaction, { query, worldId });
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
        (await this["inferWorldIdFromWorldSubspace"](interaction).catch(
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
      await this["handleWorldSubmit"](interaction, {
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
        (await this["inferWorldIdFromWorldSubspace"](interaction).catch(
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
      await this["handleWorldApprove"](interaction, { worldId, submissionId });
      return;
    }
    if (subcommand === "check") {
      const query = interaction.options.getString("query", true);
      const worldId =
        interaction.options.getInteger("world_id") ??
        (await this["inferWorldIdFromWorldSubspace"](interaction).catch(
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
      await this["handleWorldCheck"](interaction, { worldId, query });
      return;
    }
    if (subcommand === "join") {
      const worldId =
        interaction.options.getInteger("world_id") ??
        (await this["inferWorldIdFromWorldSubspace"](interaction).catch(
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
      await this["handleWorldJoin"](interaction, { worldId, characterId });
      return;
    }
    if (subcommand === "stats") {
      const worldId =
        interaction.options.getInteger("world_id") ??
        (await this["inferWorldIdFromWorldSubspace"](interaction).catch(
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
      await this["handleWorldStats"](interaction, worldId);
      return;
    }
    if (subcommand === "status") {
      const worldId =
        interaction.options.getInteger("world_id") ??
        (await this["inferWorldIdFromWorldSubspace"](interaction).catch(
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
      await this["handleWorldStats"](interaction, worldId);
      return;
    }
    if (subcommand === "search") {
      const query = interaction.options.getString("query", true);
      const limit = interaction.options.getInteger("limit") ?? undefined;
      await this["handleWorldSearch"](interaction, { query, limit });
      return;
    }
    if (subcommand === "remove") {
      const worldId = interaction.options.getInteger("world_id", true);
      await this["handleWorldRemove"](interaction, worldId, flags);
      return;
    }
    await safeReply(interaction, `未知子命令：/world ${subcommand}`, {
      ephemeral: false,
    });
  };

  (
    DiscordAdapterClass.prototype as unknown as Record<string, unknown>
  ).handleWorldCreate = async function (
    this: DiscordAdapter,
    interaction: ChatInputCommandInteraction,
    flags: { isGuildOwner: boolean; isGuildAdmin: boolean },
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
      event: "discord.world.create.start",
      traceId,
      interactionId: interaction.id,
      guildId: interaction.guildId,
      channelId: interaction.channelId,
      userId: interaction.user.id,
    });
    await safeDefer(interaction, { ephemeral: true });

    const groupPath = await this["groupRepository"].ensureGroupDir(
      interaction.guildId,
    );
    const groupConfig = await this["groupRepository"].loadConfig(groupPath);
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
      const worldId = await this["worldStore"].nextWorldId();
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

      await this["worldStore"].createWorldDraft({
        id: worldId,
        homeGuildId: interaction.guildId,
        creatorId: interaction.user.id,
        name: worldName,
        createdAt: nowIso,
        updatedAt: nowIso,
      });
      await this["userState"].markWorldCreated(interaction.user.id);

      await this["worldFiles"].ensureDefaultFiles({
        worldId,
        worldName,
        creatorId: interaction.user.id,
        language,
      });
      await this["worldFiles"].writeSourceDocument(worldId, source);
      await this["worldFiles"].appendEvent(worldId, {
        type: "world_draft_created",
        worldId,
        guildId: interaction.guildId,
        userId: interaction.user.id,
      });
      await this["worldFiles"].appendEvent(worldId, {
        type: "world_source_uploaded",
        worldId,
        guildId: interaction.guildId,
        userId: interaction.user.id,
        filename: source.filename,
      });

      await this["ensureWorldBuildGroupAgent"]({
        worldId,
        worldName,
        language,
      });

      const workshop = await this["createCreatorOnlyChannel"]({
        guild,
        name: `world-workshop-${interaction.user.id}`,
        creatorUserId: interaction.user.id,
        reason: `world workshop ensure for ${interaction.user.id}`,
      });

      const thread = await this["tryCreatePrivateThread"]({
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

      await this["worldStore"].setWorldBuildChannelId({
        worldId,
        channelId: buildConversationChannelId,
      });
      await this["worldStore"].setChannelWorldId(
        buildConversationChannelId,
        worldId,
      );
      await this["worldStore"].setChannelGroupId(
        buildConversationChannelId,
        buildWorldBuildGroupId(worldId),
      );

      await this["worldFiles"].appendEvent(worldId, {
        type: "world_draft_build_thread_created",
        worldId,
        guildId: interaction.guildId,
        userId: interaction.user.id,
        threadId: buildConversationChannelId,
        parentChannelId: thread.parentChannelId,
      });

      await this["sendWorldCreateRules"]({
        guildId: interaction.guildId,
        channelId: buildConversationChannelId,
        userId: interaction.user.id,
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
      this["logger"].error({ err }, "Failed to create world draft");
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
  };

  (
    DiscordAdapterClass.prototype as unknown as Record<string, unknown>
  ).createWorldDraftAndThread = async function (
    this: DiscordAdapter,
    input: {
      guild: Guild;
      guildId: string;
      userId: string;
      language: UserLanguage | null;
      traceId?: string;
      flags: { isGuildOwner: boolean; isGuildAdmin: boolean };
    },
  ): Promise<{
    worldId: number;
    worldName: string;
    buildConversationChannelId: string;
  }> {
    const groupPath = await this["groupRepository"].ensureGroupDir(
      input.guildId,
    );
    const groupConfig = await this["groupRepository"].loadConfig(groupPath);
    const policy = groupConfig.world.createPolicy;
    const isConfiguredAdmin = groupConfig.adminUsers.includes(input.userId);
    const isGuildAdmin = input.flags.isGuildOwner || input.flags.isGuildAdmin;
    const isWhitelisted = groupConfig.world.createWhitelist.includes(
      input.userId,
    );
    const allowed =
      policy === "open" ||
      isConfiguredAdmin ||
      isGuildAdmin ||
      (policy === "whitelist" && isWhitelisted);
    if (!allowed) {
      throw new LocalizedError({
        zh: `无权限：当前 createPolicy=${policy}（默认 admin）。`,
        en: `Permission denied: createPolicy=${policy} (default: admin).`,
      });
    }

    const nowIso = new Date().toISOString();
    const worldId = await this["worldStore"].nextWorldId();
    const worldName = `World-${worldId}`;

    const source = {
      filename: "source.md",
      content: buildWorldSourceSeedContent(input.language),
    };

    await this["worldStore"].createWorldDraft({
      id: worldId,
      homeGuildId: input.guildId,
      creatorId: input.userId,
      name: worldName,
      createdAt: nowIso,
      updatedAt: nowIso,
    });
    await this["userState"].markWorldCreated(input.userId);

    await this["worldFiles"].ensureDefaultFiles({
      worldId,
      worldName,
      creatorId: input.userId,
      language: input.language,
    });
    await this["worldFiles"].writeSourceDocument(worldId, source);
    await this["worldFiles"].appendEvent(worldId, {
      type: "world_draft_created",
      worldId,
      guildId: input.guildId,
      userId: input.userId,
    });
    await this["worldFiles"].appendEvent(worldId, {
      type: "world_source_uploaded",
      worldId,
      guildId: input.guildId,
      userId: input.userId,
      filename: source.filename,
    });

    await this["ensureWorldBuildGroupAgent"]({
      worldId,
      worldName,
      language: input.language,
    });

    const workshop = await this["createCreatorOnlyChannel"]({
      guild: input.guild,
      name: `world-workshop-${input.userId}`,
      creatorUserId: input.userId,
      reason: `world workshop ensure for ${input.userId}`,
    });

    const thread = await this["tryCreatePrivateThread"]({
      guild: input.guild,
      parentChannelId: workshop.id,
      name: pickByLanguage(
        input.language,
        `世界创建 W${worldId}`,
        `World Create W${worldId}`,
      ),
      reason: `world create W${worldId} by ${input.userId}`,
      memberUserId: input.userId,
    });
    if (!thread) {
      throw new LocalizedError({
        zh: "无法创建世界编辑话题：请检查 bot 是否具备创建话题权限（CreatePrivateThreads）",
        en: "Failed to create the world editing thread: please check the bot permission (CreatePrivateThreads).",
      });
    }

    const buildConversationChannelId = thread.threadId;

    await this["worldStore"].setWorldBuildChannelId({
      worldId,
      channelId: buildConversationChannelId,
    });
    await this["worldStore"].setChannelWorldId(
      buildConversationChannelId,
      worldId,
    );
    await this["worldStore"].setChannelGroupId(
      buildConversationChannelId,
      buildWorldBuildGroupId(worldId),
    );

    await this["worldFiles"].appendEvent(worldId, {
      type: "world_draft_build_thread_created",
      worldId,
      guildId: input.guildId,
      userId: input.userId,
      threadId: buildConversationChannelId,
      parentChannelId: thread.parentChannelId,
    });

    await this["sendWorldCreateRules"]({
      guildId: input.guildId,
      channelId: buildConversationChannelId,
      userId: input.userId,
      worldId,
      language: input.language,
      traceId: input.traceId,
    });

    return { worldId, worldName, buildConversationChannelId };
  };

  (
    DiscordAdapterClass.prototype as unknown as Record<string, unknown>
  ).handleWorldHelp = async function (
    this: DiscordAdapter,
    interaction: ChatInputCommandInteraction,
  ): Promise<void> {
    const language = await this["userState"]
      .getLanguage(interaction.user.id)
      .catch(() => null);
    await safeReply(interaction, buildDiscordWorldHelp(language), {
      ephemeral: true,
    });
  };

  (
    DiscordAdapterClass.prototype as unknown as Record<string, unknown>
  ).handleWorldExport = async function (
    this: DiscordAdapter,
    interaction: ChatInputCommandInteraction,
    input: { worldId?: number },
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
      await safeReply(interaction, "无权限：只有世界创作者可以导出世界文档。", {
        ephemeral: true,
      });
      return;
    }

    const language = await this["userState"]
      .getLanguage(interaction.user.id)
      .catch(() => null);
    await this["worldFiles"].ensureDefaultFiles({
      worldId: meta.id,
      worldName: meta.name,
      creatorId: meta.creatorId,
      language,
    });

    const [card, rules, chronicle, tasks, news, canon] = await Promise.all([
      this["worldFiles"].readWorldCard(meta.id),
      this["worldFiles"].readRules(meta.id),
      this["worldFiles"].readCanon(meta.id, "chronicle.md"),
      this["worldFiles"].readCanon(meta.id, "tasks.md"),
      this["worldFiles"].readCanon(meta.id, "news.md"),
      this["worldFiles"].readCanon(meta.id, "canon.md"),
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
  };
}
