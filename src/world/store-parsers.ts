import type {
  CharacterMeta,
  CharacterVisibility,
  WorldMeta,
  WorldStatus,
} from "./store-types";

export function parseWorldMeta(raw: Record<string, string>): WorldMeta | null {
  const id = Number(raw.id);
  if (!Number.isInteger(id) || id <= 0) {
    return null;
  }
  const status = raw.status as WorldStatus;
  if (
    status !== "draft" &&
    status !== "active" &&
    status !== "archived" &&
    status !== "failed"
  ) {
    return null;
  }

  const baseRequired = [
    "homeGuildId",
    "creatorId",
    "name",
    "createdAt",
    "updatedAt",
  ] as const;
  for (const key of baseRequired) {
    if (!raw[key] || raw[key].trim() === "") {
      return null;
    }
  }

  if (status === "draft") {
    const buildChannelId = raw.buildChannelId?.trim() || undefined;
    return {
      id,
      homeGuildId: raw.homeGuildId,
      creatorId: raw.creatorId,
      name: raw.name,
      status,
      createdAt: raw.createdAt,
      updatedAt: raw.updatedAt,
      buildChannelId,
    };
  }

  const channelRequired = [
    "roleId",
    "categoryId",
    "infoChannelId",
    "roleplayChannelId",
    "proposalsChannelId",
    "voiceChannelId",
  ] as const;
  for (const key of channelRequired) {
    if (!raw[key] || raw[key].trim() === "") {
      return null;
    }
  }

  const buildChannelId = raw.buildChannelId?.trim() || undefined;
  const joinChannelId = raw.joinChannelId?.trim() || undefined;
  const forumChannelId = raw.forumChannelId?.trim() || undefined;

  return {
    id,
    homeGuildId: raw.homeGuildId,
    creatorId: raw.creatorId,
    name: raw.name,
    status,
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
    roleId: raw.roleId,
    categoryId: raw.categoryId,
    infoChannelId: raw.infoChannelId,
    joinChannelId,
    roleplayChannelId: raw.roleplayChannelId,
    forumChannelId,
    proposalsChannelId: raw.proposalsChannelId,
    voiceChannelId: raw.voiceChannelId,
    buildChannelId,
  };
}

export function parseCharacterMeta(
  raw: Record<string, string>,
): CharacterMeta | null {
  const id = Number(raw.id);
  if (!Number.isInteger(id) || id <= 0) {
    return null;
  }
  const visibility = raw.visibility as CharacterVisibility;
  if (visibility !== "public" && visibility !== "private") {
    return null;
  }
  const status = raw.status as CharacterMeta["status"];
  if (status !== "active" && status !== "retired" && status !== "failed") {
    return null;
  }
  const required = ["creatorId", "name", "createdAt", "updatedAt"] as const;
  for (const key of required) {
    if (!raw[key] || raw[key].trim() === "") {
      return null;
    }
  }
  return {
    id,
    creatorId: raw.creatorId,
    name: raw.name,
    visibility,
    status,
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
    buildChannelId: raw.buildChannelId?.trim() || undefined,
  };
}
