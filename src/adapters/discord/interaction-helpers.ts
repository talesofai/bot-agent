import type {
  APIEmbed,
  ChatInputCommandInteraction,
  MessageComponentInteraction,
} from "discord.js";
import { feishuLogJson } from "../../feishu/webhook";
import { redactSensitiveText } from "../../utils/redact";

export async function safeReply(
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

export async function tryEditInteractionReply(
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

export async function safeReplyRich(
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

export async function safeDefer(
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

export function buildInteractionCommand(
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

export async function safeDeferUpdate(
  interaction: MessageComponentInteraction,
): Promise<void> {
  try {
    if (interaction.replied || interaction.deferred) {
      return;
    }
    await interaction.deferUpdate();
  } catch (err) {
    feishuLogJson({
      event: "log.warn",
      msg: "Failed to defer discord component interaction update",
      errName: err instanceof Error ? err.name : "Error",
      errMessage: err instanceof Error ? err.message : String(err),
      interactionId: interaction.id,
      userId: interaction.user.id,
      guildId: interaction.guildId ?? undefined,
      channelId: interaction.channelId,
    });
  }
}

export async function safeComponentFollowUp(
  interaction: MessageComponentInteraction,
  content: string,
  options: { ephemeral: boolean },
): Promise<void> {
  try {
    await interaction.followUp({ content, ephemeral: options.ephemeral });
  } catch (err) {
    feishuLogJson({
      event: "log.warn",
      msg: "Failed to follow up discord component interaction",
      errName: err instanceof Error ? err.name : "Error",
      errMessage: err instanceof Error ? err.message : String(err),
      interactionId: interaction.id,
      userId: interaction.user.id,
      guildId: interaction.guildId ?? undefined,
      channelId: interaction.channelId,
    });
  }
}

export function previewTextForLog(text: string, maxBytes: number): string {
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
