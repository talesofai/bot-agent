import { getConfig } from "../config";
import { assertSafePathSegment, isSafePathSegment } from "./path";

export function resolveCanonicalBotId(botId: string): string {
  assertSafePathSegment(botId, "botId");
  const mapped = getAliases().get(botId);
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
  return new Map(getAliases());
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
    const parts = trimmed.split(":");
    if (parts.length !== 2) {
      throw new Error(
        "Invalid BOT_ID_ALIASES entry, expected exactly one ':' (alias:canonical)",
      );
    }
    const [alias, canonical] = parts;
    if (!alias || !canonical) {
      throw new Error("Invalid BOT_ID_ALIASES entry, expected alias:canonical");
    }
    if (!isSafePathSegment(alias) || !isSafePathSegment(canonical)) {
      throw new Error("BOT_ID_ALIASES entries must be safe path segments");
    }
    if (alias === canonical) {
      throw new Error("BOT_ID_ALIASES entry must map alias to a different id");
    }
    if (map.has(alias)) {
      throw new Error(`Duplicate BOT_ID_ALIASES alias: ${alias}`);
    }
    map.set(alias, canonical);
  }
  return map;
}

let cachedAliases: Map<string, string> | null = null;
let cachedAliasesRaw: string | undefined;

function getAliases(): Map<string, string> {
  const raw = getConfig().BOT_ID_ALIASES;
  if (cachedAliases && raw === cachedAliasesRaw) {
    return cachedAliases;
  }
  cachedAliasesRaw = raw;
  cachedAliases = parseBotIdAliases(raw);
  return cachedAliases;
}
