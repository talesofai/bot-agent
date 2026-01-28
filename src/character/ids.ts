import { assertSafePathSegment } from "../utils/path";

export type CharacterId = number;

export type CharacterGroup = { kind: "build"; characterId: CharacterId };

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

export function parseCharacterGroup(groupId: string): CharacterGroup | null {
  const trimmed = groupId.trim();
  if (!trimmed) {
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
