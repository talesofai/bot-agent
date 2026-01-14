export function buildSessionId(userId: string, key: number): string {
  return `${userId}-${key}`;
}

export function assertValidSessionKey(key: number): void {
  if (!Number.isInteger(key) || key < 0) {
    throw new Error("Session key must be a non-negative integer");
  }
}

export function buildSessionLockKey(
  groupId: string,
  sessionId: string,
): string {
  return `session:lock:${groupId}:${sessionId}`;
}
