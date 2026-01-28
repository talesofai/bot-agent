import { assertSafePathSegment } from "../utils/path";

export type CharacterId = number;

export type CharacterGroup =
  | { kind: "build"; characterId: CharacterId }
  | { kind: "world_build"; worldId: number; characterId: CharacterId };

export function normalizeCharacterId(characterId: CharacterId): number {
  if (!Number.isInteger(characterId) || characterId <= 0) {
    throw new Error("characterId must be a positive integer");
  }
  return characterId;
}

export function buildCharacterBuildGroupId(characterId: CharacterId): string {
  const normalized = normalizeCharacterId(characterId);
  const groupId = `character_${normalized}_build`;
  assertSafePathSegment(groupId, "characterBuildGroupId");
  return groupId;
}

export function buildWorldCharacterBuildGroupId(input: {
  worldId: number;
  characterId: CharacterId;
}): string {
  if (!Number.isInteger(input.worldId) || input.worldId <= 0) {
    throw new Error("worldId must be a positive integer");
  }
  const normalizedCharacterId = normalizeCharacterId(input.characterId);
  const groupId = `world_${input.worldId}_character_${normalizedCharacterId}_build`;
  assertSafePathSegment(groupId, "worldCharacterBuildGroupId");
  return groupId;
}

export function parseCharacterGroup(groupId: string): CharacterGroup | null {
  const trimmed = groupId.trim();
  if (!trimmed) {
    return null;
  }

  const worldMatch = trimmed.match(/^world_(\d+)_character_(\d+)_build$/);
  if (worldMatch) {
    const worldId = Number(worldMatch[1]);
    const characterId = Number(worldMatch[2]);
    if (
      Number.isInteger(worldId) &&
      worldId > 0 &&
      Number.isInteger(characterId) &&
      characterId > 0
    ) {
      return { kind: "world_build", worldId, characterId };
    }
    return null;
  }

  const match = trimmed.match(/^character_(\d+)_build$/);
  if (!match) {
    return null;
  }
  const parsed = Number(match[1]);
  return Number.isInteger(parsed) && parsed > 0
    ? { kind: "build", characterId: parsed }
    : null;
}
