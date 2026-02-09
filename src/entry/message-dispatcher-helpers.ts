import type { GroupConfig } from "../types/group";
import type { SessionEvent } from "../types/platform";
import { parseCharacterGroup } from "../character/ids";
import { parseWorldGroup } from "../world/ids";

export function prefixSessionKey(
  message: SessionEvent,
  key: number,
): SessionEvent {
  const prefix = `#${key} `;
  return {
    ...message,
    content: `${prefix}${message.content}`,
    elements: [{ type: "text", text: prefix }, ...message.elements],
  };
}

export function shouldForceEnqueueForGroupId(groupId: string): boolean {
  const world = parseWorldGroup(groupId);
  if (world) {
    return world.kind === "build";
  }

  const character = parseCharacterGroup(groupId);
  if (character) {
    return character.kind === "build" || character.kind === "world_build";
  }

  return false;
}

export function truncateTextByBytes(content: string, maxBytes: number): string {
  if (maxBytes <= 0) {
    return "";
  }
  const trimmed = String(content ?? "").trim();
  if (!trimmed) {
    return "";
  }
  const buffer = Buffer.from(trimmed, "utf8");
  if (buffer.byteLength <= maxBytes) {
    return trimmed;
  }
  const sliced = buffer.toString("utf8", 0, maxBytes);
  return `${sliced}\n\n[truncated]`;
}

export function hasDiscordInteractionId(extras: unknown): boolean {
  if (!extras || typeof extras !== "object") {
    return false;
  }
  const record = extras as Record<string, unknown>;
  if (record["synthetic"] === true) {
    return false;
  }
  const interactionId = record["interactionId"];
  return typeof interactionId === "string" && interactionId.trim().length > 0;
}

export function resolveResetTargetUserId(message: SessionEvent): {
  targetUserId: string;
  error?: string;
} {
  const mentionUserIds = message.elements
    .flatMap((element) => (element.type === "mention" ? [element.userId] : []))
    .filter((userId) => userId !== message.selfId);
  const uniqueMentionUserIds = Array.from(new Set(mentionUserIds));

  if (uniqueMentionUserIds.length === 0) {
    return { targetUserId: message.userId };
  }
  if (uniqueMentionUserIds.length === 1) {
    return { targetUserId: uniqueMentionUserIds[0] };
  }

  return {
    targetUserId: message.userId,
    error: "一次只能指定一个用户。",
  };
}

export function isGroupAdminUser(
  message: SessionEvent,
  groupConfig: GroupConfig,
): boolean {
  if (groupConfig.adminUsers.includes(message.userId)) {
    return true;
  }
  if (message.platform !== "discord" || !message.guildId) {
    return false;
  }
  if (!isRecord(message.extras)) {
    return false;
  }
  return (
    message.extras.isGuildOwner === true || message.extras.isGuildAdmin === true
  );
}

export function parseTimeHHMM(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  const match = trimmed.match(/^(\d{1,2}):(\d{2})$/);
  if (!match) {
    return null;
  }
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) {
    return null;
  }
  if (!Number.isInteger(minute) || minute < 0 || minute > 59) {
    return null;
  }
  const hh = String(hour).padStart(2, "0");
  const mm = String(minute).padStart(2, "0");
  return `${hh}:${mm}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
