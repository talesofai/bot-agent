import { assertSafePathSegment } from "../utils/path";

export type WorldId = number;

export type WorldGroupKind = "play" | "build";

export type WorldGroup =
  | { kind: "play"; worldId: WorldId }
  | { kind: "build"; worldId: WorldId };

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

export function parseWorldGroup(groupId: string): WorldGroup | null {
  const trimmed = groupId.trim();
  if (!trimmed) {
    return null;
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
