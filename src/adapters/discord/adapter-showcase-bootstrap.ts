import path from "node:path";
import {
  buildCharacterBuildGroupId,
  buildWorldCharacterBuildGroupId,
} from "../../character/ids";
import {
  buildCharacterBuildAgentPrompt,
  buildDiscordCharacterBuildAutopilot,
  buildDiscordCharacterBuildKickoff,
  buildDiscordCharacterCreateGuide,
  buildDiscordCharacterPortraitGenerate,
  buildDiscordCharacterPortraitGenerateWithReference,
  buildDiscordWorldBuildAutopilot,
  buildDiscordWorldBuildKickoff,
  buildDiscordWorldCharacterBuildKickoff,
  buildDiscordWorldCreateGuide,
  buildWorldAgentPrompt,
  buildWorldBuildAgentPrompt,
  buildWorldCharacterBuildAgentPrompt,
} from "../../texts";
import type { SessionEvent } from "../../types/platform";
import type { UserLanguage } from "../../user/state-store";
import { buildWorldBuildGroupId, buildWorldGroupId } from "../../world/ids";
import type { DiscordInteractionExtras, DiscordAdapter } from "./adapter";
import { atomicWrite, pickByLanguage } from "./adapter-internals";
import { buildOnboardingCustomId } from "./onboarding-custom-id";
import {
  buildWorldBaseOverwrites,
  buildWorldShowcaseOverwrites,
} from "./permission-overwrites";
import { buildSlashCommands } from "./slash-commands";
import {
  buildWorldShowcaseForumOpener,
  buildWorldShowcaseForumTags,
  buildWorldShowcasePost,
  resolveForumAppliedTagIds,
} from "./world-showcase-builders";
import {
  applyWorldShowcaseCover,
  buildWorldShowcaseStarterContent,
  DiscordBufferAttachment,
  WorldShowcaseCoverImage,
} from "./world-showcase-message";
import {
  ActionRowBuilder,
  APIEmbed,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  Guild,
  MessageCreateOptions,
  REST,
  Routes,
} from "discord.js";

export function installDiscordAdapterShowcaseBootstrap(DiscordAdapterClass: {
  prototype: DiscordAdapter;
}): void {
  (
    DiscordAdapterClass.prototype as unknown as Record<string, unknown>
  ).publishWorldShowcasePost = async function (
    this: DiscordAdapter,
    input: {
      guild: Guild;
      worldId: number;
      worldName: string;
      creatorId: string;
      language: UserLanguage | null;
      coverImage?: WorldShowcaseCoverImage | null;
    },
  ): Promise<{ status: "created" | "exists"; channelId: string }> {
    const exists = await this["worldStore"].getWorldShowcasePost(input.worldId);
    if (exists) {
      return { status: "exists", channelId: exists.channelId };
    }

    const botUserId = this["botUserId"] ?? this["client"].user?.id ?? "";
    if (!botUserId) {
      throw new Error("bot user id is unavailable");
    }

    const showcase = await this["ensureWorldShowcaseChannel"]({
      guild: input.guild,
      botUserId,
      reason: `world showcase ensure for W${input.worldId}`,
    });
    const channel = await input.guild.channels
      .fetch(showcase.channelId)
      .catch(() => null);
    if (!channel) {
      throw new Error(`showcase channel not found: ${showcase.channelId}`);
    }

    const threadName = `W${input.worldId} ${input.worldName}`.slice(0, 100);
    const reason = `world publish W${input.worldId}`;

    const [card, rules] = await Promise.all([
      this["worldFiles"].readWorldCard(input.worldId),
      this["worldFiles"].readRules(input.worldId),
    ]);
    const opener = buildWorldShowcaseForumOpener({
      worldId: input.worldId,
      worldName: input.worldName,
      creatorId: input.creatorId,
      language: input.language,
      card,
    });
    const payload = buildWorldShowcasePost({
      worldId: input.worldId,
      worldName: input.worldName,
      creatorId: input.creatorId,
      language: input.language,
      card,
      rules,
    });
    const starterContent = buildWorldShowcaseStarterContent({
      opener,
      content: payload.content,
    });
    const showcased = applyWorldShowcaseCover({
      embeds: payload.embeds,
      cover: input.coverImage,
    });
    const showcaseEmbeds = showcased.embeds;
    const showcaseFiles = showcased.files;

    let threadId: string | null = null;
    let messageId: string | null = null;
    if (showcase.mode === "forum") {
      const appliedTags = resolveForumAppliedTagIds({ channel, card });
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
              create: (input: Record<string, unknown>) => Promise<{
                id: string;
                fetchStarterMessage?: () => Promise<{ id: string }>;
              }>;
            };
          }
        ).threads.create({
          name: threadName,
          message: {
            content: starterContent,
            embeds: showcaseEmbeds,
            ...(showcaseFiles.length > 0 ? { files: showcaseFiles } : {}),
          },
          ...(appliedTags.length > 0 ? { appliedTags } : {}),
          reason,
        });
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
      throw new Error("failed to create world showcase thread");
    }

    if (!messageId) {
      messageId = await this["sendRichToChannelAndGetId"]({
        channelId: threadId,
        content: showcase.mode === "forum" ? payload.content : starterContent,
        embeds: showcaseEmbeds,
        files: showcaseFiles,
      });
    }
    if (!messageId) {
      throw new Error("failed to send world showcase message");
    }

    await this["worldStore"].setWorldShowcasePost({
      worldId: input.worldId,
      channelId: showcase.channelId,
      threadId,
      messageId,
    });
    return { status: "created", channelId: showcase.channelId };
  };

  (
    DiscordAdapterClass.prototype as unknown as Record<string, unknown>
  ).ensureWorldShowcaseChannel = async function (
    this: DiscordAdapter,
    input: {
      guild: Guild;
      botUserId: string;
      reason: string;
    },
  ): Promise<{ channelId: string; mode: "forum" | "text" }> {
    const channelName = "world-index";
    const legacyChannelName = "world-showcase";
    const overwrites = buildWorldShowcaseOverwrites({
      everyoneRoleId: input.guild.roles.everyone.id,
      botUserId: input.botUserId,
    });

    const syncChannelPermissions = async (channel: unknown): Promise<void> => {
      try {
        const setter = (channel as { permissionOverwrites?: { set?: unknown } })
          .permissionOverwrites?.set;
        if (typeof setter === "function") {
          await (
            channel as {
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
    };

    const resolveMode = (type: number): "forum" | "text" =>
      type === ChannelType.GuildForum ? "forum" : "text";

    const findChannelByName = (
      name: string,
    ): { id: string; type: number; edit?: unknown } | null => {
      const found = input.guild.channels.cache.find(
        (candidate) =>
          (candidate.type === ChannelType.GuildForum ||
            candidate.type === ChannelType.GuildText) &&
          candidate.name === name,
      );
      if (!found) {
        return null;
      }
      return found as unknown as { id: string; type: number; edit?: unknown };
    };

    const existingPreferred = findChannelByName(channelName);
    if (existingPreferred) {
      await syncChannelPermissions(existingPreferred);
      await this["ensureWorldShowcaseForumTags"]({
        channelId: existingPreferred.id,
        reason: input.reason,
      });
      return {
        channelId: existingPreferred.id,
        mode: resolveMode(existingPreferred.type),
      };
    }

    const existingLegacy = findChannelByName(legacyChannelName);
    if (existingLegacy) {
      try {
        const renamer = existingLegacy.edit;
        if (typeof renamer === "function") {
          await (
            existingLegacy as {
              edit: (input: Record<string, unknown>) => Promise<unknown>;
            }
          ).edit({ name: channelName, reason: input.reason });
        }
      } catch {
        // ignore
      }
      await syncChannelPermissions(existingLegacy);
      await this["ensureWorldShowcaseForumTags"]({
        channelId: existingLegacy.id,
        reason: input.reason,
      });
      return {
        channelId: existingLegacy.id,
        mode: resolveMode(existingLegacy.type),
      };
    }

    try {
      const forum = await input.guild.channels.create({
        name: channelName,
        type: ChannelType.GuildForum,
        availableTags: buildWorldShowcaseForumTags(),
        permissionOverwrites: overwrites,
        reason: input.reason,
      });
      return { channelId: forum.id, mode: "forum" };
    } catch (err) {
      this["logger"].warn(
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
  };

  (
    DiscordAdapterClass.prototype as unknown as Record<string, unknown>
  ).ensureWorldShowcaseForumTags = async function (
    this: DiscordAdapter,
    input: {
      channelId: string;
      reason: string;
    },
  ): Promise<void> {
    const channel = await this["client"].channels
      .fetch(input.channelId)
      .catch(() => null);
    if (!channel || channel.type !== ChannelType.GuildForum) {
      return;
    }

    const editor = (channel as unknown as { edit?: unknown }).edit;
    if (typeof editor !== "function") {
      return;
    }

    try {
      await (
        channel as unknown as {
          edit: (input: Record<string, unknown>) => Promise<unknown>;
        }
      ).edit({
        availableTags: buildWorldShowcaseForumTags(),
        reason: input.reason,
      });
    } catch {
      // ignore
    }
  };

  (
    DiscordAdapterClass.prototype as unknown as Record<string, unknown>
  ).sendRichToChannelAndGetId = async function (
    this: DiscordAdapter,
    input: {
      channelId: string;
      content?: string;
      embeds?: APIEmbed[];
      files?: DiscordBufferAttachment[];
    },
  ): Promise<string | null> {
    const channel = await this["client"].channels
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
    const payload: MessageCreateOptions = {};
    const content = input.content?.trim() ?? "";
    if (content) {
      payload.content = content;
    }
    if (input.embeds && input.embeds.length > 0) {
      payload.embeds = input.embeds;
    }
    if (input.files && input.files.length > 0) {
      payload.files = input.files;
    }
    if (
      !payload.content &&
      (!payload.embeds || payload.embeds.length === 0) &&
      (!payload.files || payload.files.length === 0)
    ) {
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
  };

  (
    DiscordAdapterClass.prototype as unknown as Record<string, unknown>
  ).sendWorldCreateRules = async function (
    this: DiscordAdapter,
    input: {
      guildId?: string;
      channelId: string;
      userId: string;
      worldId: number;
      language: UserLanguage | null;
      traceId?: string;
    },
  ): Promise<void> {
    await this["sendLongTextToChannel"]({
      guildId: input.guildId,
      channelId: input.channelId,
      traceId: input.traceId,
      content: buildDiscordWorldCreateGuide({
        worldId: input.worldId,
        language: input.language,
      }),
    });

    const embeds: APIEmbed[] = [
      {
        title: pickByLanguage(input.language, "快捷操作", "Quick Actions"),
        description: pickByLanguage(
          input.language,
          "可点【自动推进】让 LLM 先整理一版；确认 OK 后点【发布】；也可用下方【中文/English】切换语言。",
          "Click “Autopilot” to let the LLM draft a first pass, then click “Publish” when ready; you can also switch language below.",
        ),
      },
    ];
    const isEnglish = input.language === "en";
    const components: MessageCreateOptions["components"] = [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(
            buildOnboardingCustomId({
              userId: input.userId,
              action: "world_autopilot",
              payload: String(input.worldId),
            }),
          )
          .setLabel(isEnglish ? "Autopilot" : "自动推进")
          .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
          .setCustomId(
            buildOnboardingCustomId({
              userId: input.userId,
              action: "world_publish",
              payload: String(input.worldId),
            }),
          )
          .setLabel(isEnglish ? "Publish" : "发布")
          .setStyle(ButtonStyle.Success),
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
          .setLabel(input.language === "en" ? "Menu" : "新手菜单")
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId(
            buildOnboardingCustomId({
              userId: input.userId,
              action: "help",
            }),
          )
          .setLabel(input.language === "en" ? "Help" : "帮助")
          .setStyle(ButtonStyle.Secondary),
      ),
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(
            buildOnboardingCustomId({
              userId: input.userId,
              action: "language_set",
              payload: "zh",
            }),
          )
          .setLabel("中文")
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(!isEnglish),
        new ButtonBuilder()
          .setCustomId(
            buildOnboardingCustomId({
              userId: input.userId,
              action: "language_set",
              payload: "en",
            }),
          )
          .setLabel("English")
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(isEnglish),
      ),
    ];

    await this["sendRichToChannel"]({
      guildId: input.guildId,
      channelId: input.channelId,
      embeds,
      components,
      traceId: input.traceId,
    });
  };

  (
    DiscordAdapterClass.prototype as unknown as Record<string, unknown>
  ).sendCharacterCreateRules = async function (
    this: DiscordAdapter,
    input: {
      guildId?: string;
      channelId: string;
      userId: string;
      characterId: number;
      language: UserLanguage | null;
      traceId?: string;
    },
  ): Promise<void> {
    await this["sendLongTextToChannel"]({
      guildId: input.guildId,
      channelId: input.channelId,
      traceId: input.traceId,
      content: buildDiscordCharacterCreateGuide({
        characterId: input.characterId,
        language: input.language,
      }),
    });

    const embeds: APIEmbed[] = [
      {
        title: pickByLanguage(input.language, "快捷操作", "Quick Actions"),
        description: pickByLanguage(
          input.language,
          "可点【自动推进】让 LLM 先整理一版；满意后点【公开角色】；也可随时查看角色卡并加入世界。",
          "Click “Autopilot” for a first draft, then “Publish Character” when ready; you can also view the card and join a world.",
        ),
      },
    ];
    const isEnglish = input.language === "en";
    const components: MessageCreateOptions["components"] = [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(
            buildOnboardingCustomId({
              userId: input.userId,
              action: "character_autopilot",
              payload: String(input.characterId),
            }),
          )
          .setLabel(isEnglish ? "Autopilot" : "自动推进")
          .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
          .setCustomId(
            buildOnboardingCustomId({
              userId: input.userId,
              action: "character_publish",
              payload: String(input.characterId),
            }),
          )
          .setLabel(isEnglish ? "Publish Character" : "公开角色")
          .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
          .setCustomId(
            buildOnboardingCustomId({
              userId: input.userId,
              action: "character_show",
              payload: String(input.characterId),
            }),
          )
          .setLabel(input.language === "en" ? "View Card" : "查看角色卡")
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId(
            buildOnboardingCustomId({
              userId: input.userId,
              action: "world_list",
            }),
          )
          .setLabel(isEnglish ? "Join World" : "加入世界")
          .setStyle(ButtonStyle.Secondary),
      ),
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(
            buildOnboardingCustomId({
              userId: input.userId,
              action: "character_generate_portrait",
              payload: String(input.characterId),
            }),
          )
          .setLabel(input.language === "en" ? "Portrait" : "生成角色立绘")
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId(
            buildOnboardingCustomId({
              userId: input.userId,
              action: "character_generate_portrait_ref",
              payload: String(input.characterId),
            }),
          )
          .setLabel(
            input.language === "en"
              ? "Portrait (Ref)"
              : "生成角色立绘（参考图）",
          )
          .setStyle(ButtonStyle.Secondary),
      ),
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(
            buildOnboardingCustomId({
              userId: input.userId,
              action: "language_set",
              payload: "zh",
            }),
          )
          .setLabel("中文")
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(!isEnglish),
        new ButtonBuilder()
          .setCustomId(
            buildOnboardingCustomId({
              userId: input.userId,
              action: "language_set",
              payload: "en",
            }),
          )
          .setLabel("English")
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(isEnglish),
        new ButtonBuilder()
          .setCustomId(
            buildOnboardingCustomId({
              userId: input.userId,
              action: "menu",
            }),
          )
          .setLabel(isEnglish ? "Menu" : "新手菜单")
          .setStyle(ButtonStyle.Secondary),
      ),
    ];

    await this["sendRichToChannel"]({
      guildId: input.guildId,
      channelId: input.channelId,
      embeds,
      components,
      traceId: input.traceId,
    });
  };

  (
    DiscordAdapterClass.prototype as unknown as Record<string, unknown>
  ).migrateWorldSubspaceChannels = async function (
    this: DiscordAdapter,
  ): Promise<void> {
    const ids = await this["worldStore"].listWorldIds(200);
    const botId = this["botUserId"] ?? this["client"].user?.id ?? "";
    for (const id of ids) {
      const meta = await this["worldStore"].getWorld(id);
      if (!meta || meta.status !== "active") {
        continue;
      }
      const guild = await this["client"].guilds
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
        this["logger"].warn(
          { err, worldId: meta.id, guildId: meta.homeGuildId },
          "Failed to migrate world announcements channel name",
        );
      }

      // Ensure world subspace channels and creator permissions (best-effort).
      try {
        const overwrites = buildWorldBaseOverwrites({
          everyoneRoleId: guild.roles.everyone.id,
          worldRoleId: meta.roleId,
          creatorUserId: meta.creatorId,
          botUserId: botId,
        });

        const syncPermissions = async (
          channel: unknown,
          values: Array<{ id: string; allow?: bigint[]; deny?: bigint[] }>,
          reason: string,
        ): Promise<void> => {
          const setter = (
            channel as { permissionOverwrites?: { set?: unknown } }
          ).permissionOverwrites?.set;
          if (typeof setter !== "function") {
            return;
          }
          await (
            channel as {
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
          ).permissionOverwrites.set(values, reason);
        };

        let discussion = guild.channels.cache.find(
          (candidate) =>
            candidate.type === ChannelType.GuildText &&
            candidate.parentId === category.id &&
            candidate.name === "world-discussion",
        );
        if (!discussion) {
          discussion = await guild.channels.create({
            name: "world-discussion",
            type: ChannelType.GuildText,
            parent: category.id,
            permissionOverwrites: overwrites.roleplay,
            reason: `world discussion ensure W${meta.id}`,
          });
          await this["worldFiles"].appendEvent(meta.id, {
            type: "world_discussion_channel_created",
            worldId: meta.id,
            guildId: meta.homeGuildId,
          });
        } else {
          await syncPermissions(
            discussion,
            overwrites.roleplay,
            `world discussion permission sync W${meta.id}`,
          );
        }

        let proposals = guild.channels.cache.find(
          (candidate) =>
            candidate.type === ChannelType.GuildText &&
            candidate.parentId === category.id &&
            candidate.name === "world-proposals",
        );
        if (!proposals) {
          proposals = await guild.channels.create({
            name: "world-proposals",
            type: ChannelType.GuildText,
            parent: category.id,
            permissionOverwrites: overwrites.proposals,
            reason: `world proposals ensure W${meta.id}`,
          });
          await this["worldFiles"].appendEvent(meta.id, {
            type: "world_proposals_channel_created",
            worldId: meta.id,
            guildId: meta.homeGuildId,
          });
        } else {
          await syncPermissions(
            proposals,
            overwrites.proposals,
            `world proposals permission sync W${meta.id}`,
          );
        }

        let forum = guild.channels.cache.find(
          (candidate) =>
            (candidate.type === ChannelType.GuildForum ||
              candidate.type === ChannelType.GuildText) &&
            candidate.parentId === category.id &&
            candidate.name === "world-forum",
        );
        let forumMode: "forum" | "text" =
          forum && forum.type === ChannelType.GuildForum ? "forum" : "text";
        if (!forum) {
          forumMode = "forum";
          forum = await guild.channels
            .create({
              name: "world-forum",
              type: ChannelType.GuildForum,
              parent: category.id,
              permissionOverwrites: overwrites.forum,
              reason: `world forum ensure W${meta.id}`,
            })
            .catch(async (err) => {
              this["logger"].warn(
                { err, worldId: meta.id, guildId: meta.homeGuildId },
                "Failed to create world forum channel during migration; fallback to text",
              );
              forumMode = "text";
              return guild.channels.create({
                name: "world-forum",
                type: ChannelType.GuildText,
                parent: category.id,
                permissionOverwrites: overwrites.forum,
                reason: `world forum ensure W${meta.id}`,
              });
            });
          await this["worldFiles"].appendEvent(meta.id, {
            type: "world_forum_channel_created",
            worldId: meta.id,
            guildId: meta.homeGuildId,
            mode: forumMode,
          });
        } else {
          await syncPermissions(
            forum,
            overwrites.forum,
            `world forum permission sync W${meta.id}`,
          );
        }

        if (forum?.id && meta.forumChannelId !== forum.id) {
          await this["worldStore"]
            .setWorldForumChannelId({
              worldId: meta.id,
              channelId: forum.id,
            })
            .catch(() => {
              // ignore
            });
        }
      } catch (err) {
        this["logger"].warn(
          { err, worldId: meta.id, guildId: meta.homeGuildId },
          "Failed to migrate world subspace channels",
        );
      }
    }
  };

  (
    DiscordAdapterClass.prototype as unknown as Record<string, unknown>
  ).ensureWorldGroupAgent = async function (
    this: DiscordAdapter,
    input: {
      worldId: number;
      worldName: string;
      language: UserLanguage | null;
    },
  ): Promise<void> {
    const groupId = buildWorldGroupId(input.worldId);
    const groupPath = await this["groupRepository"].ensureGroupDir(groupId);
    const agentPath = path.join(groupPath, "agent.md");
    const content = buildWorldAgentPrompt({
      worldId: input.worldId,
      worldName: input.worldName,
      language: input.language,
    });
    await atomicWrite(agentPath, content);
  };

  (
    DiscordAdapterClass.prototype as unknown as Record<string, unknown>
  ).ensureWorldBuildGroupAgent = async function (
    this: DiscordAdapter,
    input: {
      worldId: number;
      worldName: string;
      language: UserLanguage | null;
    },
  ): Promise<void> {
    const groupId = buildWorldBuildGroupId(input.worldId);
    const groupPath = await this["groupRepository"].ensureGroupDir(groupId);
    const agentPath = path.join(groupPath, "agent.md");
    const content = buildWorldBuildAgentPrompt({
      worldId: input.worldId,
      worldName: input.worldName,
      language: input.language,
    });
    await atomicWrite(agentPath, content);
  };

  (
    DiscordAdapterClass.prototype as unknown as Record<string, unknown>
  ).ensureCharacterBuildGroupAgent = async function (
    this: DiscordAdapter,
    input: {
      characterId: number;
      characterName: string;
      language: UserLanguage | null;
    },
  ): Promise<void> {
    const groupId = buildCharacterBuildGroupId(input.characterId);
    const groupPath = await this["groupRepository"].ensureGroupDir(groupId);
    const agentPath = path.join(groupPath, "agent.md");
    const content = buildCharacterBuildAgentPrompt({
      characterId: input.characterId,
      characterName: input.characterName,
      language: input.language,
    });
    await atomicWrite(agentPath, content);
  };

  (
    DiscordAdapterClass.prototype as unknown as Record<string, unknown>
  ).ensureWorldCharacterBuildGroupAgent = async function (
    this: DiscordAdapter,
    input: {
      worldId: number;
      worldName: string;
      characterId: number;
      characterName: string;
      language: UserLanguage | null;
    },
  ): Promise<void> {
    const groupId = buildWorldCharacterBuildGroupId({
      worldId: input.worldId,
      characterId: input.characterId,
    });
    const groupPath = await this["groupRepository"].ensureGroupDir(groupId);
    const agentPath = path.join(groupPath, "agent.md");
    const content = buildWorldCharacterBuildAgentPrompt({
      worldId: input.worldId,
      worldName: input.worldName,
      characterId: input.characterId,
      characterName: input.characterName,
      language: input.language,
    });
    await atomicWrite(agentPath, content);
  };

  (
    DiscordAdapterClass.prototype as unknown as Record<string, unknown>
  ).emitSyntheticWorldBuildKickoff = async function (
    this: DiscordAdapter,
    input: {
      channelId: string;
      userId: string;
      worldId: number;
      worldName: string;
      traceId?: string;
    },
  ): Promise<void> {
    if (this["listenerCount"]("event") === 0) {
      return;
    }
    const botId = this["botUserId"]?.trim() ?? "";
    if (!botId) {
      return;
    }
    const language = await this["userState"]
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
    await this["emitEvent"]({
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
  };

  (
    DiscordAdapterClass.prototype as unknown as Record<string, unknown>
  ).emitSyntheticWorldBuildAutopilot = async function (
    this: DiscordAdapter,
    input: {
      channelId: string;
      userId: string;
      worldId: number;
      worldName: string;
      traceId?: string;
    },
  ): Promise<void> {
    if (this["listenerCount"]("event") === 0) {
      return;
    }
    const botId = this["botUserId"]?.trim() ?? "";
    if (!botId) {
      return;
    }
    const language = await this["userState"]
      .getLanguage(input.userId)
      .catch(() => null);
    const content = buildDiscordWorldBuildAutopilot({
      worldId: input.worldId,
      worldName: input.worldName,
      language,
    });

    const messageId = `synthetic-world-autopilot-${Date.now()}-${Math.random()
      .toString(16)
      .slice(2)}`;
    await this["emitEvent"]({
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
        commandName: "world.autopilot",
        channelId: input.channelId,
        guildId: undefined,
        userId: input.userId,
      },
    } satisfies SessionEvent<DiscordInteractionExtras>);
  };

  (
    DiscordAdapterClass.prototype as unknown as Record<string, unknown>
  ).emitSyntheticCharacterBuildKickoff = async function (
    this: DiscordAdapter,
    input: {
      channelId: string;
      userId: string;
      characterId: number;
      characterName: string;
      traceId?: string;
    },
  ): Promise<void> {
    if (this["listenerCount"]("event") === 0) {
      return;
    }
    const botId = this["botUserId"]?.trim() ?? "";
    if (!botId) {
      return;
    }

    const language = await this["userState"]
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
    await this["emitEvent"]({
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
  };

  (
    DiscordAdapterClass.prototype as unknown as Record<string, unknown>
  ).emitSyntheticCharacterBuildAutopilot = async function (
    this: DiscordAdapter,
    input: {
      channelId: string;
      userId: string;
      characterId: number;
      characterName: string;
      traceId?: string;
    },
  ): Promise<void> {
    if (this["listenerCount"]("event") === 0) {
      return;
    }
    const botId = this["botUserId"]?.trim() ?? "";
    if (!botId) {
      return;
    }

    const language = await this["userState"]
      .getLanguage(input.userId)
      .catch(() => null);
    const content = buildDiscordCharacterBuildAutopilot({
      characterId: input.characterId,
      characterName: input.characterName,
      language,
    });

    const messageId = `synthetic-character-autopilot-${Date.now()}-${Math.random()
      .toString(16)
      .slice(2)}`;
    await this["emitEvent"]({
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
        commandName: "character.autopilot",
        channelId: input.channelId,
        guildId: undefined,
        userId: input.userId,
      },
    } satisfies SessionEvent<DiscordInteractionExtras>);
  };

  (
    DiscordAdapterClass.prototype as unknown as Record<string, unknown>
  ).emitSyntheticCharacterPortraitGenerate = async function (
    this: DiscordAdapter,
    input: {
      channelId: string;
      userId: string;
      characterId: number;
      characterName: string;
      withReference: boolean;
      traceId?: string;
    },
  ): Promise<void> {
    if (this["listenerCount"]("event") === 0) {
      return;
    }
    const botId = this["botUserId"]?.trim() ?? "";
    if (!botId) {
      return;
    }

    const language = await this["userState"]
      .getLanguage(input.userId)
      .catch(() => null);
    const content = input.withReference
      ? buildDiscordCharacterPortraitGenerateWithReference({
          characterId: input.characterId,
          characterName: input.characterName,
          language,
        })
      : buildDiscordCharacterPortraitGenerate({
          characterId: input.characterId,
          characterName: input.characterName,
          language,
        });

    const messageId = `synthetic-character-portrait-${Date.now()}-${Math.random()
      .toString(16)
      .slice(2)}`;
    await this["emitEvent"]({
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
        commandName: input.withReference
          ? "character.portrait.reference"
          : "character.portrait",
        channelId: input.channelId,
        guildId: undefined,
        userId: input.userId,
      },
    } satisfies SessionEvent<DiscordInteractionExtras>);
  };

  (
    DiscordAdapterClass.prototype as unknown as Record<string, unknown>
  ).emitSyntheticWorldCharacterBuildKickoff = async function (
    this: DiscordAdapter,
    input: {
      channelId: string;
      userId: string;
      worldId: number;
      worldName: string;
      characterId: number;
      characterName: string;
      traceId?: string;
    },
  ): Promise<void> {
    if (this["listenerCount"]("event") === 0) {
      return;
    }
    const botId = this["botUserId"]?.trim() ?? "";
    if (!botId) {
      return;
    }
    const language = await this["userState"]
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
    await this["emitEvent"]({
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
  };

  (
    DiscordAdapterClass.prototype as unknown as Record<string, unknown>
  ).resolveDiscordUserLabel = async function (
    this: DiscordAdapter,
    input: {
      userId: string;
      guild?: Guild | null;
    },
  ): Promise<string> {
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

    const user = await this["client"].users.fetch(userId).catch(() => null);
    const name = (user?.globalName ?? user?.username ?? "").trim();
    return name ? `${mention}（${name}）` : mention;
  };

  (
    DiscordAdapterClass.prototype as unknown as Record<string, unknown>
  ).registerSlashCommands = async function (
    this: DiscordAdapter,
  ): Promise<void> {
    const applicationId =
      this["applicationId"] ?? this["client"].application?.id ?? null;
    if (!applicationId) {
      this["logger"].warn(
        "Missing Discord application id; skip slash commands",
      );
      return;
    }

    const commands = buildSlashCommands();
    const rest = new REST({ version: "10" }).setToken(this["token"]);

    const guildIds = this["client"].guilds.cache.map((guild) => guild.id);
    if (guildIds.length === 0) {
      try {
        await rest.put(Routes.applicationCommands(applicationId), {
          body: commands,
        });
        this["logger"].info(
          { applicationId },
          "Registered global slash commands",
        );
      } catch (err) {
        this["logger"].warn(
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
          this["logger"].info(
            { applicationId, guildId },
            "Registered guild slash commands",
          );
        } catch (err) {
          this["logger"].warn(
            { err, applicationId, guildId },
            "Failed to register guild commands",
          );
        }
      }),
    );
  };
}
