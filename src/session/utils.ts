export function buildSessionId(userId: string, key: number): string {
  return `${userId}-${key}`;
}
