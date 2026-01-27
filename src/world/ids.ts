import { assertSafePathSegment } from "../utils/path";

export type WorldId = number;

export type WorldGroupKind = "play" | "build" | "character_build";

export type WorldGroup =
  | { kind: "play"; worldId: WorldId }
  | { kind: "build"; worldId: WorldId }
  | { kind: "character_build"; worldId: WorldId; characterId: number };

export function buildWorldGroupId(worldId: WorldId): string {
  const normalized = normalizeWorldId(worldId);
  const groupId = `world_${normalized}`;
  assertSafePathSegment(groupId, "worldGroupId");
  return groupId;
}

export function buildWorldBuildGroupId(worldId: WorldId): string {
  const normalized = normalizeWorldId(worldId);
  const groupId = `world_${normalized}_build`;
  assertSafePathSegment(groupId, "worldBuildGroupId");
  return groupId;
}

export function buildWorldCharacterBuildGroupId(
  worldId: WorldId,
  characterId: number,
): string {
  const normalizedWorldId = normalizeWorldId(worldId);
  if (!Number.isInteger(characterId) || characterId <= 0) {
    throw new Error("characterId must be a positive integer");
  }
  const groupId = `world_${normalizedWorldId}_character_${characterId}_build`;
  assertSafePathSegment(groupId, "worldCharacterBuildGroupId");
  return groupId;
}

export function parseWorldGroup(groupId: string): WorldGroup | null {
  const trimmed = groupId.trim();
  if (!trimmed) {
    return null;
  }

  const characterBuildMatch = trimmed.match(
    /^world_(\d+)_character_(\d+)_build$/,
  );
  if (characterBuildMatch) {
    const worldId = Number(characterBuildMatch[1]);
    const characterId = Number(characterBuildMatch[2]);
    return Number.isInteger(worldId) &&
      worldId > 0 &&
      Number.isInteger(characterId) &&
      characterId > 0
      ? { kind: "character_build", worldId, characterId }
      : null;
  }

  const playMatch = trimmed.match(/^world_(\d+)$/);
  if (playMatch) {
    const parsed = Number(playMatch[1]);
    return Number.isInteger(parsed) && parsed > 0
      ? { kind: "play", worldId: parsed }
      : null;
  }

  const buildMatch = trimmed.match(/^world_(\d+)_build$/);
  if (buildMatch) {
    const parsed = Number(buildMatch[1]);
    return Number.isInteger(parsed) && parsed > 0
      ? { kind: "build", worldId: parsed }
      : null;
  }

  return null;
}

export function parseWorldGroupId(groupId: string): WorldId | null {
  return parseWorldGroup(groupId)?.worldId ?? null;
}

export function normalizeWorldId(worldId: WorldId): number {
  if (!Number.isInteger(worldId) || worldId <= 0) {
    throw new Error("worldId must be a positive integer");
  }
  return worldId;
}
