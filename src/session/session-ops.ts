import type { GroupFileRepository } from "../store/repository";
import type { SessionInfo, SessionMeta } from "../types/session";
import { assertSafePathSegment } from "../utils/path";
import { assertValidSessionKey } from "./utils";
import type { SessionRepository } from "./repository";

export interface CreateSessionInput {
  groupId: string;
  userId: string;
  key?: number;
  maxSessions?: number;
  groupRepository: GroupFileRepository;
  sessionRepository: SessionRepository;
}

export async function createSession(
  input: CreateSessionInput,
): Promise<SessionInfo> {
  const { groupId, userId, groupRepository, sessionRepository } = input;
  assertSafePathSegment(groupId, "groupId");
  assertSafePathSegment(userId, "userId");

  const key = input.key ?? 0;
  assertValidSessionKey(key);

  const sessionId = sessionRepository.getSessionId(userId, key);
  const existing = await sessionRepository.loadSession(groupId, sessionId);
  if (existing) {
    if (existing.meta.ownerId !== userId) {
      throw new Error("Session ownership mismatch");
    }
    return existing;
  }

  await groupRepository.ensureGroupDir(groupId);
  const groupPath = sessionRepository.getGroupPath(groupId);
  const config = await groupRepository.loadConfig(groupPath);
  const maxSessions = input.maxSessions ?? config.maxSessions;
  assertValidMaxSessions(maxSessions);

  if (key >= maxSessions) {
    throw new Error("Session key exceeds maxSessions for this group");
  }

  const now = new Date().toISOString();
  const meta: SessionMeta = {
    sessionId,
    groupId,
    ownerId: userId,
    key,
    status: "idle",
    createdAt: now,
    updatedAt: now,
  };

  return sessionRepository.createSession(meta);
}

function assertValidMaxSessions(maxSessions: number): void {
  if (!Number.isInteger(maxSessions) || maxSessions < 1) {
    throw new Error("maxSessions must be a positive integer");
  }
}
