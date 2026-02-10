import { parseCharacterGroup } from "../../character/ids";
import { feishuLogJson } from "../../feishu/webhook";
import { createTraceId } from "../../telemetry";
import { buildDiscordHelp } from "../../texts";
import type { SessionElement, SessionEvent } from "../../types/platform";
import type { UserLanguage, UserRole } from "../../user/state-store";
import { parseWorldGroup } from "../../world/ids";
import type { DiscordInteractionExtras, DiscordAdapter } from "./adapter";
import {
  pickByLanguage,
  resolveUserMessageFromError,
} from "./adapter-internals";
import {
  buildInteractionCommand,
  safeComponentFollowUp,
  safeDefer,
  safeDeferUpdate,
  safeReply,
} from "./interaction-helpers";
import {
  buildMarkdownCardEmbeds,
  chunkEmbedsForDiscord,
} from "./markdown-cards";
import {
  buildOnboardingCustomId,
  OnboardingComponentAction,
  parseOnboardingCustomId,
} from "./onboarding-custom-id";
import {
  ActionRowBuilder,
  APIEmbed,
  ButtonBuilder,
  ButtonInteraction,
  ButtonStyle,
  ChatInputCommandInteraction,
  Guild,
  Interaction,
  MessageComponentInteraction,
  MessageCreateOptions,
  PermissionFlagsBits,
  StringSelectMenuInteraction,
} from "discord.js";

export function installDiscordAdapterInteractionOnboarding(DiscordAdapterClass: {
  prototype: DiscordAdapter;
}): void {
  (
    DiscordAdapterClass.prototype as unknown as Record<string, unknown>
  ).handleInteraction = async function (
    this: DiscordAdapter,
    interaction: Interaction,
  ): Promise<void> {
    if (interaction.isButton()) {
      await this["handleButtonInteraction"](interaction);
      return;
    }
    if (interaction.isStringSelectMenu()) {
      await this["handleStringSelectMenuInteraction"](interaction);
      return;
    }
    if (!interaction.isChatInputCommand()) {
      return;
    }

    await this["maybeSeedUserLanguage"](interaction);

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
      const language = await this["userState"]
        .getLanguage(interaction.user.id)
        .catch(() => null);
      await safeReply(interaction, buildDiscordHelp(language), {
        ephemeral: true,
      });
      return;
    }
    if (commandName === "onboard") {
      await this["handleOnboard"](interaction);
      return;
    }
    if (commandName === "language") {
      await this["handleLanguage"](interaction);
      return;
    }
    if (commandName === "world") {
      await this["handleWorldCommand"](interaction, {
        isGuildOwner,
        isGuildAdmin,
      });
      return;
    }
    if (commandName === "character") {
      await this["handleCharacterCommand"](interaction, {
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
      const botId = this["botUserId"] ?? this["client"].user?.id ?? "";
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
      this["rememberPendingInteractionReply"](interaction);

      if (this["listenerCount"]("event") === 0) {
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
      await this["emitEvent"](event);
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
      const botId = this["botUserId"] ?? this["client"].user?.id ?? "";
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
      this["rememberPendingInteractionReply"](interaction);

      if (this["listenerCount"]("event") === 0) {
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
      await this["emitEvent"](event);
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
      const botId = this["botUserId"] ?? this["client"].user?.id ?? "";
      if (!botId) {
        await safeReply(interaction, "Bot 尚未就绪，请稍后重试。", {
          ephemeral: true,
        });
        return;
      }

      const name = interaction.options.getString("name", true).trim();
      const content = `/model ${name}`;

      await safeReply(interaction, "收到，正在切换模型…", { ephemeral: true });
      this["rememberPendingInteractionReply"](interaction);

      if (this["listenerCount"]("event") === 0) {
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
      await this["emitEvent"](event);
      return;
    }
    await safeReply(interaction, `未知指令：/${commandName}`, {
      ephemeral: false,
    });
  };

  (
    DiscordAdapterClass.prototype as unknown as Record<string, unknown>
  ).handleButtonInteraction = async function (
    this: DiscordAdapter,
    interaction: ButtonInteraction,
  ): Promise<void> {
    const parsed = parseOnboardingCustomId(interaction.customId);
    if (!parsed) {
      await safeDeferUpdate(interaction);
      return;
    }
    await safeDeferUpdate(interaction);
    await this["handleOnboardingComponentAction"](interaction, parsed);
  };

  (
    DiscordAdapterClass.prototype as unknown as Record<string, unknown>
  ).handleStringSelectMenuInteraction = async function (
    this: DiscordAdapter,
    interaction: StringSelectMenuInteraction,
  ): Promise<void> {
    const parsed = parseOnboardingCustomId(interaction.customId);
    if (!parsed) {
      await safeDeferUpdate(interaction);
      return;
    }
    await safeDeferUpdate(interaction);
    await this["handleOnboardingComponentAction"](interaction, parsed);
  };

  (
    DiscordAdapterClass.prototype as unknown as Record<string, unknown>
  ).handleOnboard = async function (
    this: DiscordAdapter,
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
    await this["userState"].addRoles(interaction.user.id, uniqueRoles);
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

    const created: Array<{ role: UserRole; channelId: string }> = [];
    for (const role of uniqueRoles) {
      const threadId = await this["ensureOnboardingThread"]({
        guild: interaction.guild,
        userId: interaction.user.id,
        role,
        language,
        reason: `onboard role=${roleRaw}`,
      });
      await this["sendOnboardingMenu"]({
        guildId: interaction.guildId,
        channelId: threadId,
        userId: interaction.user.id,
        role,
        language,
      });
      created.push({ role, channelId: threadId });
    }

    const roleLabel =
      language === "en"
        ? (role: UserRole) =>
            role === "admin"
              ? "admin / 管理员"
              : role === "world creater"
                ? "world creater / 世界创建者"
                : "adventurer / 冒险者"
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
  };

  (
    DiscordAdapterClass.prototype as unknown as Record<string, unknown>
  ).handleOnboardingComponentAction = async function (
    this: DiscordAdapter,
    interaction: MessageComponentInteraction,
    parsed: {
      userId: string;
      action: OnboardingComponentAction;
      payload: string;
    },
  ): Promise<void> {
    if (interaction.user.id !== parsed.userId) {
      await safeComponentFollowUp(interaction, "这不是给你的按钮。", {
        ephemeral: true,
      });
      return;
    }
    const language = await this["userState"]
      .getLanguage(interaction.user.id)
      .catch(() => null);

    if (!interaction.guildId || !interaction.guild) {
      await safeComponentFollowUp(
        interaction,
        pickByLanguage(
          language,
          "该操作仅支持在服务器内使用。",
          "This action can only be used in a server.",
        ),
        { ephemeral: true },
      );
      return;
    }

    const role =
      (await this["inferOnboardingRoleForChannel"]({
        userId: interaction.user.id,
        channelId: interaction.channelId,
      })) ?? "adventurer";

    const isGuildOwner = interaction.guild.ownerId === interaction.user.id;
    const isGuildAdmin = Boolean(
      interaction.memberPermissions?.has(PermissionFlagsBits.Administrator) ||
      interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild),
    );

    if (parsed.action === "language_set") {
      const next =
        parsed.payload === "en" ? "en" : parsed.payload === "zh" ? "zh" : null;
      if (!next) {
        await safeComponentFollowUp(
          interaction,
          pickByLanguage(language, "无效的语言。", "Invalid language."),
          { ephemeral: true },
        );
        return;
      }
      await this["userState"].setLanguage(interaction.user.id, next);

      const groupId = await this["worldStore"]
        .getGroupIdByChannel(interaction.channelId)
        .catch(() => null);
      const parsedWorld = groupId ? parseWorldGroup(groupId) : null;
      const parsedCharacter = groupId ? parseCharacterGroup(groupId) : null;
      if (parsedWorld) {
        const meta = await this["worldStore"].getWorld(parsedWorld.worldId);
        if (meta) {
          if (parsedWorld.kind === "build") {
            await this["ensureWorldBuildGroupAgent"]({
              worldId: meta.id,
              worldName: meta.name,
              language: next,
            });
            await this["sendWorldCreateRules"]({
              guildId: interaction.guildId,
              channelId: interaction.channelId,
              userId: interaction.user.id,
              worldId: meta.id,
              language: next,
            });
          } else {
            await this["ensureWorldGroupAgent"]({
              worldId: meta.id,
              worldName: meta.name,
              language: next,
            });
          }
        }
      } else if (parsedCharacter) {
        const meta = await this["worldStore"].getCharacter(
          parsedCharacter.characterId,
        );
        if (meta) {
          if (parsedCharacter.kind === "build") {
            await this["ensureCharacterBuildGroupAgent"]({
              characterId: meta.id,
              characterName: meta.name,
              language: next,
            });
            await this["sendCharacterCreateRules"]({
              guildId: interaction.guildId,
              channelId: interaction.channelId,
              userId: interaction.user.id,
              characterId: meta.id,
              language: next,
            });
          } else {
            const worldMeta = await this["worldStore"].getWorld(
              parsedCharacter.worldId,
            );
            if (worldMeta) {
              await this["ensureWorldCharacterBuildGroupAgent"]({
                worldId: worldMeta.id,
                worldName: worldMeta.name,
                characterId: meta.id,
                characterName: meta.name,
                language: next,
              });
            }
          }
        }
      }

      await safeComponentFollowUp(
        interaction,
        next === "en" ? `Language set: ${next}` : `已设置语言：${next}`,
        { ephemeral: true },
      );
      return;
    }

    if (parsed.action === "menu") {
      let menuRole = role;
      if (menuRole === "adventurer") {
        const groupId = await this["worldStore"]
          .getGroupIdByChannel(interaction.channelId)
          .catch(() => null);
        const parsedWorld = groupId ? parseWorldGroup(groupId) : null;
        if (parsedWorld?.kind === "build") {
          menuRole = "world creater";
        }
      }
      await this["sendOnboardingMenu"]({
        guildId: interaction.guildId,
        channelId: interaction.channelId,
        userId: interaction.user.id,
        role: menuRole,
        language,
      });
      return;
    }

    if (parsed.action === "help") {
      await this["sendLongTextToChannel"]({
        guildId: interaction.guildId,
        channelId: interaction.channelId,
        content: buildDiscordHelp(language),
      });
      return;
    }

    if (parsed.action === "character_create") {
      try {
        const traceId = createTraceId();
        const created = await this["createCharacterDraftAndThread"]({
          guild: interaction.guild,
          guildId: interaction.guildId,
          userId: interaction.user.id,
          language,
          traceId,
          visibility: "private",
        });
        await this["sendOnboardingAfterCharacterCreate"]({
          guildId: interaction.guildId,
          channelId: interaction.channelId,
          userId: interaction.user.id,
          language,
          characterId: created.characterId,
          characterName: created.characterName,
          buildChannelId: created.buildConversationChannelId,
        });
      } catch (err) {
        await safeComponentFollowUp(
          interaction,
          resolveUserMessageFromError(language, err, {
            zh: `创建失败：${err instanceof Error ? err.message : String(err)}`,
            en: `Failed: ${err instanceof Error ? err.message : String(err)}`,
          }),
          { ephemeral: true },
        );
      }
      return;
    }

    if (parsed.action === "character_autopilot") {
      const expectedCharacterId = Number(parsed.payload);
      if (
        (!Number.isInteger(expectedCharacterId) || expectedCharacterId <= 0) &&
        parsed.payload.trim()
      ) {
        await safeComponentFollowUp(
          interaction,
          pickByLanguage(
            language,
            "无效的 character_id。",
            "Invalid character_id.",
          ),
          { ephemeral: true },
        );
        return;
      }

      const resolved = await this["resolveCharacterBuildDraftFromChannel"]({
        channelId: interaction.channelId,
        expectedCharacterId:
          Number.isInteger(expectedCharacterId) && expectedCharacterId > 0
            ? expectedCharacterId
            : null,
        requesterUserId: interaction.user.id,
        language,
        requireCreator: true,
      });
      if (!resolved.ok) {
        await safeComponentFollowUp(interaction, resolved.message, {
          ephemeral: true,
        });
        return;
      }
      const { meta } = resolved;

      const traceId = createTraceId();
      await this["ensureCharacterBuildGroupAgent"]({
        characterId: meta.id,
        characterName: meta.name,
        language,
      });
      await this["emitSyntheticCharacterBuildAutopilot"]({
        channelId: interaction.channelId,
        userId: interaction.user.id,
        characterId: meta.id,
        characterName: meta.name,
        traceId,
      });
      await safeComponentFollowUp(
        interaction,
        pickByLanguage(
          language,
          "已开始自动推进整理，请稍等片刻…",
          "Autopilot started. Please wait…",
        ),
        { ephemeral: true },
      );
      return;
    }

    if (parsed.action === "character_generate_portrait") {
      const characterId = Number(parsed.payload);
      if (!Number.isInteger(characterId) || characterId <= 0) {
        await safeComponentFollowUp(
          interaction,
          pickByLanguage(
            language,
            "无效的 character_id。",
            "Invalid character_id.",
          ),
          { ephemeral: true },
        );
        return;
      }

      const meta = await this["worldStore"].getCharacter(characterId);
      if (!meta) {
        await safeComponentFollowUp(
          interaction,
          pickByLanguage(
            language,
            `角色不存在：C${characterId}`,
            `Character not found: C${characterId}`,
          ),
          {
            ephemeral: true,
          },
        );
        return;
      }
      if (meta.creatorId !== interaction.user.id) {
        await safeComponentFollowUp(
          interaction,
          pickByLanguage(
            language,
            "无权限：只有角色创作者可以执行该操作。",
            "Permission denied: only the character creator can do this.",
          ),
          {
            ephemeral: true,
          },
        );
        return;
      }

      const targetChannelId =
        meta.buildChannelId?.trim() || interaction.channelId;

      const traceId = createTraceId();
      await this["ensureCharacterBuildGroupAgent"]({
        characterId: meta.id,
        characterName: meta.name,
        language,
      });
      await this["emitSyntheticCharacterPortraitGenerate"]({
        channelId: targetChannelId,
        userId: interaction.user.id,
        characterId: meta.id,
        characterName: meta.name,
        withReference: false,
        traceId,
      });
      await safeComponentFollowUp(
        interaction,
        pickByLanguage(
          language,
          targetChannelId === interaction.channelId
            ? "已发送立绘生成请求，请稍等…"
            : `已发送立绘生成请求到 <#${targetChannelId}>，请稍等…`,
          targetChannelId === interaction.channelId
            ? "Portrait generation request sent. Please wait…"
            : `Portrait generation request sent to <#${targetChannelId}>. Please wait…`,
        ),
        {
          ephemeral: true,
        },
      );
      return;
    }

    if (parsed.action === "character_generate_portrait_ref") {
      const characterId = Number(parsed.payload);
      if (!Number.isInteger(characterId) || characterId <= 0) {
        await safeComponentFollowUp(
          interaction,
          pickByLanguage(
            language,
            "无效的 character_id。",
            "Invalid character_id.",
          ),
          { ephemeral: true },
        );
        return;
      }

      const meta = await this["worldStore"].getCharacter(characterId);
      if (!meta) {
        await safeComponentFollowUp(
          interaction,
          pickByLanguage(
            language,
            `角色不存在：C${characterId}`,
            `Character not found: C${characterId}`,
          ),
          {
            ephemeral: true,
          },
        );
        return;
      }
      if (meta.creatorId !== interaction.user.id) {
        await safeComponentFollowUp(
          interaction,
          pickByLanguage(
            language,
            "无权限：只有角色创作者可以执行该操作。",
            "Permission denied: only the character creator can do this.",
          ),
          {
            ephemeral: true,
          },
        );
        return;
      }

      const targetChannelId =
        meta.buildChannelId?.trim() || interaction.channelId;

      const traceId = createTraceId();
      await this["ensureCharacterBuildGroupAgent"]({
        characterId: meta.id,
        characterName: meta.name,
        language,
      });
      await this["emitSyntheticCharacterPortraitGenerate"]({
        channelId: targetChannelId,
        userId: interaction.user.id,
        characterId: meta.id,
        characterName: meta.name,
        withReference: true,
        traceId,
      });
      await safeComponentFollowUp(
        interaction,
        pickByLanguage(
          language,
          targetChannelId === interaction.channelId
            ? "已发送参考图立绘生成请求，请稍等…"
            : `已发送参考图立绘生成请求到 <#${targetChannelId}>，请稍等…`,
          targetChannelId === interaction.channelId
            ? "Portrait-with-reference request sent. Please wait…"
            : `Portrait-with-reference request sent to <#${targetChannelId}>. Please wait…`,
        ),
        {
          ephemeral: true,
        },
      );
      return;
    }

    if (parsed.action === "character_publish") {
      const expectedCharacterId = Number(parsed.payload);
      if (
        (!Number.isInteger(expectedCharacterId) || expectedCharacterId <= 0) &&
        parsed.payload.trim()
      ) {
        await safeComponentFollowUp(
          interaction,
          pickByLanguage(
            language,
            "无效的 character_id。",
            "Invalid character_id.",
          ),
          { ephemeral: true },
        );
        return;
      }

      const resolved = await this["resolveCharacterBuildDraftFromChannel"]({
        channelId: interaction.channelId,
        expectedCharacterId:
          Number.isInteger(expectedCharacterId) && expectedCharacterId > 0
            ? expectedCharacterId
            : null,
        requesterUserId: interaction.user.id,
        language,
        requireCreator: true,
      });
      if (!resolved.ok) {
        await safeComponentFollowUp(interaction, resolved.message, {
          ephemeral: true,
        });
        return;
      }
      const { meta } = resolved;

      await safeComponentFollowUp(
        interaction,
        pickByLanguage(
          language,
          "收到，正在公开角色…",
          "Got it. Publishing character…",
        ),
        { ephemeral: true },
      );
      try {
        await this["worldStore"].setCharacterVisibility({
          characterId: meta.id,
          visibility: "public",
        });
        await safeComponentFollowUp(
          interaction,
          pickByLanguage(
            language,
            `已公开角色：C${meta.id} ${meta.name}`,
            `Character published: C${meta.id} ${meta.name}`,
          ),
          { ephemeral: true },
        );
      } catch (err) {
        await safeComponentFollowUp(
          interaction,
          resolveUserMessageFromError(language, err, {
            zh: `公开失败：${err instanceof Error ? err.message : String(err)}`,
            en: `Failed: ${err instanceof Error ? err.message : String(err)}`,
          }),
          { ephemeral: true },
        );
      }
      return;
    }

    if (parsed.action === "character_show") {
      const characterId = Number(parsed.payload);
      if (!Number.isInteger(characterId) || characterId <= 0) {
        await safeComponentFollowUp(
          interaction,
          pickByLanguage(
            language,
            "无效的 character_id。",
            "Invalid character_id.",
          ),
          { ephemeral: true },
        );
        return;
      }
      await this["sendCharacterCardToChannel"]({
        guildId: interaction.guildId,
        channelId: interaction.channelId,
        requesterUserId: interaction.user.id,
        language,
        characterId,
        guild: interaction.guild,
      });
      return;
    }

    if (parsed.action === "world_create") {
      try {
        const traceId = createTraceId();
        const created = await this["createWorldDraftAndThread"]({
          guild: interaction.guild,
          guildId: interaction.guildId,
          userId: interaction.user.id,
          language,
          traceId,
          flags: { isGuildOwner, isGuildAdmin },
        });
        await this["sendOnboardingAfterWorldCreate"]({
          guildId: interaction.guildId,
          channelId: interaction.channelId,
          userId: interaction.user.id,
          language,
          worldId: created.worldId,
          worldName: created.worldName,
          buildChannelId: created.buildConversationChannelId,
        });
      } catch (err) {
        await safeComponentFollowUp(
          interaction,
          resolveUserMessageFromError(language, err, {
            zh: `创建失败：${err instanceof Error ? err.message : String(err)}`,
            en: `Failed: ${err instanceof Error ? err.message : String(err)}`,
          }),
          { ephemeral: true },
        );
      }
      return;
    }

    if (parsed.action === "world_autopilot") {
      const expectedWorldId = Number(parsed.payload);
      if (
        (!Number.isInteger(expectedWorldId) || expectedWorldId <= 0) &&
        parsed.payload.trim()
      ) {
        await safeComponentFollowUp(
          interaction,
          pickByLanguage(language, "无效的 world_id。", "Invalid world_id."),
          { ephemeral: true },
        );
        return;
      }

      const resolved = await this["resolveWorldBuildDraftFromChannel"]({
        channelId: interaction.channelId,
        expectedWorldId:
          Number.isInteger(expectedWorldId) && expectedWorldId > 0
            ? expectedWorldId
            : null,
        requesterUserId: interaction.user.id,
        language,
        requireCreator: true,
      });
      if (!resolved.ok) {
        await safeComponentFollowUp(interaction, resolved.message, {
          ephemeral: true,
        });
        return;
      }
      const { meta } = resolved;

      const traceId = createTraceId();
      await this["ensureWorldBuildGroupAgent"]({
        worldId: meta.id,
        worldName: meta.name,
        language,
      });
      await this["emitSyntheticWorldBuildAutopilot"]({
        channelId: interaction.channelId,
        userId: interaction.user.id,
        worldId: meta.id,
        worldName: meta.name,
        traceId,
      });
      await safeComponentFollowUp(
        interaction,
        pickByLanguage(
          language,
          "已开始自动推进整理，请稍等片刻…",
          "Autopilot started. Please wait…",
        ),
        { ephemeral: true },
      );
      return;
    }

    if (parsed.action === "world_show") {
      const worldId = Number(parsed.payload);
      if (!Number.isInteger(worldId) || worldId <= 0) {
        await safeComponentFollowUp(
          interaction,
          pickByLanguage(language, "无效的 world_id。", "Invalid world_id."),
          { ephemeral: true },
        );
        return;
      }
      await this["sendWorldCardToChannel"]({
        guildId: interaction.guildId,
        channelId: interaction.channelId,
        requesterUserId: interaction.user.id,
        language,
        worldId,
        guild: interaction.guild,
      });
      return;
    }

    if (parsed.action === "world_list") {
      await this["sendOnboardingWorldList"]({
        guildId: interaction.guildId,
        channelId: interaction.channelId,
        userId: interaction.user.id,
        language,
      });
      return;
    }

    if (parsed.action === "world_select") {
      if (!interaction.isStringSelectMenu()) {
        return;
      }
      const selected = interaction.values?.[0]?.trim() ?? "";
      if (!selected) {
        return;
      }
      const worldId = Number(selected);
      if (!Number.isInteger(worldId) || worldId <= 0) {
        return;
      }
      await this["handleOnboardingWorldJoin"]({
        guildId: interaction.guildId,
        guild: interaction.guild,
        channelId: interaction.channelId,
        userId: interaction.user.id,
        language,
        worldId,
      });
      return;
    }

    if (parsed.action === "world_join") {
      const worldId = Number(parsed.payload);
      if (!Number.isInteger(worldId) || worldId <= 0) {
        await safeComponentFollowUp(interaction, "无效的 world_id。", {
          ephemeral: true,
        });
        return;
      }
      if (interaction.isStringSelectMenu()) {
        const selected = interaction.values?.[0]?.trim() ?? "";
        const characterId = Number(selected);
        if (!Number.isInteger(characterId) || characterId <= 0) {
          await safeComponentFollowUp(interaction, "无效的 character_id。", {
            ephemeral: true,
          });
          return;
        }
        await this["handleOnboardingWorldJoin"]({
          guildId: interaction.guildId,
          guild: interaction.guild,
          channelId: interaction.channelId,
          userId: interaction.user.id,
          language,
          worldId,
          explicitCharacterId: characterId,
        });
        return;
      }
      await this["handleOnboardingWorldJoin"]({
        guildId: interaction.guildId,
        guild: interaction.guild,
        channelId: interaction.channelId,
        userId: interaction.user.id,
        language,
        worldId,
      });
      return;
    }

    if (parsed.action === "world_publish") {
      await safeComponentFollowUp(
        interaction,
        pickByLanguage(language, "收到，正在发布世界…", "Got it. Publishing…"),
        { ephemeral: true },
      );
      try {
        const message = await this["publishWorldFromBuildChannel"]({
          channelId: interaction.channelId,
          requesterUserId: interaction.user.id,
          language,
        });
        await safeComponentFollowUp(interaction, message, {
          ephemeral: true,
        });
      } catch (err) {
        await safeComponentFollowUp(
          interaction,
          resolveUserMessageFromError(language, err, {
            zh: `发布失败：${err instanceof Error ? err.message : String(err)}`,
            en: `Failed: ${err instanceof Error ? err.message : String(err)}`,
          }),
          { ephemeral: true },
        );
      }
      return;
    }
  };

  (
    DiscordAdapterClass.prototype as unknown as Record<string, unknown>
  ).inferOnboardingRoleForChannel = async function (
    this: DiscordAdapter,
    input: {
      userId: string;
      channelId: string;
    },
  ): Promise<UserRole | null> {
    const state = await this["userState"].read(input.userId).catch(() => null);
    const threads = state?.onboardingThreadIds ?? null;
    if (!threads) {
      return null;
    }
    const roles: UserRole[] = ["admin", "world creater", "adventurer"];
    for (const role of roles) {
      const threadId = threads[role];
      if (typeof threadId === "string" && threadId === input.channelId) {
        return role;
      }
    }
    return null;
  };

  (
    DiscordAdapterClass.prototype as unknown as Record<string, unknown>
  ).sendOnboardingMenu = async function (
    this: DiscordAdapter,
    input: {
      guildId: string;
      channelId: string;
      userId: string;
      role: UserRole;
      language: UserLanguage | null;
    },
  ): Promise<void> {
    const title =
      input.language === "en"
        ? `[Onboarding] ${input.role}`
        : input.role === "world creater"
          ? "【新手引导】世界创建者"
          : input.role === "admin"
            ? "【新手引导】管理员"
            : "【新手引导】冒险者";

    const descriptionLines: string[] = [];
    if (input.language === "en") {
      descriptionLines.push(
        "This is your private guide thread (only you and the bot can see it).",
        "You can talk to the bot directly here (no @).",
        "",
      );
      if (input.role === "world creater") {
        descriptionLines.push(
          "Workflow:",
          "1) Click Create World",
          "2) Paste/upload lore in the editing thread",
          "3) Publish when ready (/world publish)",
          "",
          "Click the button below to start. (Commands still work: /world create)",
        );
      } else if (input.role === "admin") {
        descriptionLines.push(
          "Admin tips:",
          "- /language to set default language",
          "- /model to set guild model override",
          "- /resetall to reset sessions",
          "",
          "Click Help if you need the full command list.",
        );
      } else {
        descriptionLines.push(
          "Workflow:",
          "1) Click Create Character",
          "2) After finishing your character, click Join World",
          "",
          "Click the button below to start. (Commands still work: /character create, /world join)",
        );
      }
    } else {
      descriptionLines.push(
        "这是你专属的私密引导话题（只有你和 bot 能看到）。",
        "在这里无需 @，直接说话即可。",
        "",
      );
      if (input.role === "world creater") {
        descriptionLines.push(
          "流程：",
          "1) 点击【创建新世界】",
          "2) 在编辑话题粘贴/上传设定原文",
          "3) 确认 OK 后发布（/world publish）",
          "",
          "现在点下面按钮开始。（指令仍可用：/world create）",
        );
      } else if (input.role === "admin") {
        descriptionLines.push(
          "管理员常用：",
          "- /language 设置默认语言",
          "- /model 设置群模型覆盖",
          "- /resetall 重置全群会话",
          "",
          "需要完整指令清单就点“帮助”。",
        );
      } else {
        descriptionLines.push(
          "流程：",
          "1) 点击【创建角色卡】",
          "2) 完善角色卡后，点击【加入现有世界】",
          "",
          "现在点下面按钮开始。（指令仍可用：/character create、/world join）",
        );
      }
    }
    const description = descriptionLines.join("\n");

    const embeds: APIEmbed[] = [{ title, description }];
    const components = this["buildOnboardingMenuComponents"]({
      userId: input.userId,
      role: input.role,
      language: input.language,
    });

    await this["sendRichToChannel"]({
      guildId: input.guildId,
      channelId: input.channelId,
      embeds,
      components,
    });
  };

  (
    DiscordAdapterClass.prototype as unknown as Record<string, unknown>
  ).buildOnboardingMenuComponents = function (
    this: DiscordAdapter,
    input: {
      userId: string;
      role: UserRole;
      language: UserLanguage | null;
    },
  ): MessageCreateOptions["components"] {
    const menuId = buildOnboardingCustomId({
      userId: input.userId,
      action: "menu",
    });
    const helpId = buildOnboardingCustomId({
      userId: input.userId,
      action: "help",
    });
    const worldCreateId = buildOnboardingCustomId({
      userId: input.userId,
      action: "world_create",
    });
    const characterCreateId = buildOnboardingCustomId({
      userId: input.userId,
      action: "character_create",
    });
    const worldListId = buildOnboardingCustomId({
      userId: input.userId,
      action: "world_list",
    });

    const row1 = new ActionRowBuilder<ButtonBuilder>();

    if (input.role === "world creater") {
      row1.addComponents(
        new ButtonBuilder()
          .setCustomId(worldCreateId)
          .setLabel(input.language === "en" ? "Create World" : "创建新世界")
          .setStyle(ButtonStyle.Primary),
      );
      row1.addComponents(
        new ButtonBuilder()
          .setCustomId(helpId)
          .setLabel(input.language === "en" ? "Help" : "帮助")
          .setStyle(ButtonStyle.Secondary),
      );
      return [row1];
    }

    if (input.role === "admin") {
      row1.addComponents(
        new ButtonBuilder()
          .setCustomId(helpId)
          .setLabel(input.language === "en" ? "Help" : "帮助")
          .setStyle(ButtonStyle.Primary),
      );
      return [row1];
    }

    row1.addComponents(
      new ButtonBuilder()
        .setCustomId(characterCreateId)
        .setLabel(input.language === "en" ? "Create Character" : "创建角色卡")
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId(worldListId)
        .setLabel(input.language === "en" ? "Join World" : "加入现有世界")
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(helpId)
        .setLabel(input.language === "en" ? "Help" : "帮助")
        .setStyle(ButtonStyle.Secondary),
    );

    const row2 = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(menuId)
        .setLabel(input.language === "en" ? "Refresh" : "刷新菜单")
        .setStyle(ButtonStyle.Secondary),
    );
    return [row1, row2];
  };

  (
    DiscordAdapterClass.prototype as unknown as Record<string, unknown>
  ).sendOnboardingAfterCharacterCreate = async function (
    this: DiscordAdapter,
    input: {
      guildId: string;
      channelId: string;
      userId: string;
      language: UserLanguage | null;
      characterId: number;
      characterName: string;
      buildChannelId: string;
    },
  ): Promise<void> {
    const embeds: APIEmbed[] = [
      {
        title:
          input.language === "en"
            ? "Step 1: Character Created"
            : "第 1 步：角色已创建",
        description:
          input.language === "en"
            ? [
                `C${input.characterId} ${input.characterName}`,
                `Continue editing here: <#${input.buildChannelId}>`,
                "",
                "When you're ready, come back and join a world.",
              ].join("\n")
            : [
                `C${input.characterId} ${input.characterName}`,
                `去这里完善角色卡：<#${input.buildChannelId}>`,
                "",
                "完善后回来点按钮加入世界。",
              ].join("\n"),
      },
    ];

    const components: MessageCreateOptions["components"] = [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(
            buildOnboardingCustomId({
              userId: input.userId,
              action: "character_generate_portrait",
              payload: String(input.characterId),
            }),
          )
          .setLabel(
            input.language === "en" ? "Generate Portrait" : "生成角色立绘",
          )
          .setStyle(ButtonStyle.Primary),
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
              ? "Generate Portrait (Ref)"
              : "生成角色立绘（参考图）",
          )
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
  ).sendCharacterCardToChannel = async function (
    this: DiscordAdapter,
    input: {
      guildId: string;
      channelId: string;
      requesterUserId: string;
      language: UserLanguage | null;
      characterId: number;
      guild: Guild;
    },
  ): Promise<void> {
    const meta = await this["worldStore"].getCharacter(input.characterId);
    if (!meta) {
      await this["sendRichToChannel"]({
        guildId: input.guildId,
        channelId: input.channelId,
        content: pickByLanguage(
          input.language,
          `角色不存在：C${input.characterId}`,
          `Character not found: C${input.characterId}`,
        ),
      });
      return;
    }

    const allowed =
      meta.visibility === "public" ||
      (meta.visibility === "private" &&
        meta.creatorId === input.requesterUserId);
    if (!allowed) {
      await this["sendRichToChannel"]({
        guildId: input.guildId,
        channelId: input.channelId,
        content: pickByLanguage(
          input.language,
          "无权限查看该角色卡。",
          "Permission denied: you cannot view this character card.",
        ),
      });
      return;
    }

    const card = await this["worldFiles"].readCharacterCard(meta.id);
    if (!card?.trim()) {
      await this["sendRichToChannel"]({
        guildId: input.guildId,
        channelId: input.channelId,
        content: pickByLanguage(
          input.language,
          "角色卡为空（可能仍在生成中）。请稍后重试。",
          "Character card is empty (it may still be generating). Please retry later.",
        ),
      });
      return;
    }

    const creatorLabel = await this["resolveDiscordUserLabel"]({
      userId: meta.creatorId,
      guild: input.guild,
    });

    const patched = card.trim();
    const embeds: APIEmbed[] = [
      {
        title: `C${meta.id} ${meta.name}`,
        fields: [
          {
            name: pickByLanguage(input.language, "创建者", "Creator"),
            value: creatorLabel || `<@${meta.creatorId}>`,
            inline: true,
          },
          {
            name: pickByLanguage(input.language, "可见性", "Visibility"),
            value: meta.visibility,
            inline: true,
          },
          {
            name: pickByLanguage(input.language, "状态", "Status"),
            value: meta.status,
            inline: true,
          },
        ],
      },
      ...buildMarkdownCardEmbeds(patched, {
        titlePrefix: pickByLanguage(input.language, "角色卡", "Character Card"),
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

    const nextEmbeds: APIEmbed[] = [
      {
        title: pickByLanguage(input.language, "下一步", "Next"),
        description: pickByLanguage(
          input.language,
          "准备好了就加入一个世界吧。",
          "Join a world when you're ready.",
        ),
      },
    ];
    const components: MessageCreateOptions["components"] = [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(
            buildOnboardingCustomId({
              userId: input.requesterUserId,
              action: "world_list",
            }),
          )
          .setLabel(input.language === "en" ? "Join World" : "加入世界")
          .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
          .setCustomId(
            buildOnboardingCustomId({
              userId: input.requesterUserId,
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
      embeds: nextEmbeds,
      components,
    });
  };
}
