import { assertSafePathSegment } from "../utils/path";

export type WorldId = number;

export function buildWorldGroupId(worldId: WorldId): string {
  const normalized = normalizeWorldId(worldId);
  const groupId = `world_${normalized}`;
  assertSafePathSegment(groupId, "worldGroupId");
  return groupId;
}

export function parseWorldGroupId(groupId: string): WorldId | null {
  const match = groupId.match(/^world_(\d+)$/);
  if (!match) {
    return null;
  }
  const parsed = Number(match[1]);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

export function normalizeWorldId(worldId: WorldId): number {
  if (!Number.isInteger(worldId) || worldId <= 0) {
    throw new Error("worldId must be a positive integer");
  }
  return worldId;
}
