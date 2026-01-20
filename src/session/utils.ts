import { randomBytes } from "node:crypto";

export function generateSessionId(): string {
  return `s-${Date.now().toString(36)}-${randomBytes(6).toString("hex")}`;
}

export function assertValidSessionKey(key: number): void {
  if (!Number.isInteger(key) || key < 0) {
    throw new Error("Session key must be a non-negative integer");
  }
}
