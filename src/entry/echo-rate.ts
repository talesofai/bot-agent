export function resolveEchoRate(
  botEchoRate: number | null | undefined,
  groupEchoRate: number | null | undefined,
  globalEchoRate: number,
): number {
  return botEchoRate ?? groupEchoRate ?? globalEchoRate;
}
