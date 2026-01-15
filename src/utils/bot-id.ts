import { getConfig } from "../config";
import { assertSafePathSegment, isSafePathSegment } from "./path";

export function resolveCanonicalBotId(botId: string): string {
  assertSafePathSegment(botId, "botId");
  const mapped = BOT_ID_ALIASES.get(botId);
  return mapped ?? botId;
}

export function buildBotAccountId(platform: string, botId: string): string {
  assertSafePathSegment(platform, "platform");
  const canonicalId = resolveCanonicalBotId(botId);
  return `${platform}:${canonicalId}`;
}

export function buildBotFsId(platform: string, botId: string): string {
  assertSafePathSegment(platform, "platform");
  const canonicalId = resolveCanonicalBotId(botId);
  const fsId = `${platform}-${canonicalId}`;
  assertSafePathSegment(fsId, "botId");
  return fsId;
}

export function getBotIdAliasMap(): Map<string, string> {
  return new Map(BOT_ID_ALIASES);
}

export function parseBotIdAliases(raw?: string): Map<string, string> {
  const map = new Map<string, string>();
  if (!raw) {
    return map;
  }
  for (const entry of raw.split(",")) {
    const trimmed = entry.trim();
    if (!trimmed) {
      continue;
    }
    const [alias, canonical] = trimmed.split(":");
    if (!alias || !canonical) {
      throw new Error("Invalid BOT_ID_ALIASES entry, expected alias:canonical");
    }
    if (!isSafePathSegment(alias) || !isSafePathSegment(canonical)) {
      throw new Error("BOT_ID_ALIASES entries must be safe path segments");
    }
    if (alias === canonical) {
      throw new Error("BOT_ID_ALIASES entry must map alias to a different id");
    }
    map.set(alias, canonical);
  }
  return map;
}

const BOT_ID_ALIASES = parseBotIdAliases(getConfig().BOT_ID_ALIASES);
