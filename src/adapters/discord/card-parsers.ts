import type { Message } from "discord.js";

export function extractCharacterCardField(
  card: string | null,
  key: { zh: string; en: string },
): string | null {
  const raw = (card ?? "").trim();
  if (!raw) return null;
  const normalized = raw.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const label = `${escapeRegExp(key.zh)}|${escapeRegExp(key.en)}`;
  const bulletMatch = normalized.match(
    new RegExp(`^\\s*-\\s*(?:${label})\\s*[:：]\\s*(.+)\\s*$`, "m"),
  );
  const value = (bulletMatch?.[1] ?? "").trim();
  return value ? clampText(value, 240) : null;
}

export function extractCharacterCardSection(
  card: string | null,
  heading: { zh: string; en: string },
): string | null {
  const raw = (card ?? "").trim();
  if (!raw) {
    return null;
  }
  const normalized = raw.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const lines = normalized.split("\n");
  const headingPattern = new RegExp(
    `^\\s*##\\s*(?:${escapeRegExp(heading.zh)}|${escapeRegExp(heading.en)})\\s*$`,
    "i",
  );
  const anyHeadingPattern = /^\s*##\s+.+$/;

  let start = -1;
  for (let index = 0; index < lines.length; index += 1) {
    if (headingPattern.test(lines[index] ?? "")) {
      start = index + 1;
      break;
    }
  }
  if (start < 0) {
    return null;
  }

  const collected: string[] = [];
  for (let index = start; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (anyHeadingPattern.test(line)) {
      break;
    }
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    if (trimmed === "-" || trimmed === "-：" || trimmed === "-:") {
      continue;
    }
    collected.push(trimmed);
  }
  if (collected.length === 0) {
    return null;
  }

  const compact = collected
    .map((line) => line.replace(/^[-*]\s*/, "").trim())
    .filter(Boolean)
    .join("; ");
  return compact ? clampText(compact, 320) : null;
}

export function extractWorldOneLiner(card: string | null): string | null {
  const raw = (card ?? "").trim();
  if (!raw) return null;
  const normalized = raw.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const bulletMatch = normalized.match(
    /^\\s*-\\s*(?:一句话简介|One-line Summary)\\s*[:：]\\s*(.+)\\s*$/m,
  );
  const tableMatch = normalized.match(
    /^\\s*\\|\\s*(?:一句话简介|One-line Summary)\\s*\\|\\s*([^|\\n]+?)\\s*\\|/m,
  );
  const summary = (bulletMatch?.[1] ?? tableMatch?.[1] ?? "").trim();
  if (!summary) return null;
  return summary.length > 80 ? `${summary.slice(0, 80)}…` : summary;
}

export function parseWorldCardTagKeywords(raw: string | null): string[] {
  const text = raw?.trim() ?? "";
  if (!text) {
    return [];
  }
  const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const parts = normalized
    .split(/[\n,，、;/｜|]+/g)
    .map((part) => normalizeForumTagName(part))
    .filter(Boolean);
  return Array.from(new Set(parts));
}

export function normalizeForumTagName(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/^#+/g, "")
    .replace(/[\s_-]+/g, "")
    .replace(/[()（）【】[\]{}]/g, "");
}

export function extractWorldCardField(
  card: string | null,
  key: { zh: string; en: string },
): string | null {
  const raw = (card ?? "").trim();
  if (!raw) return null;
  const normalized = raw.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const label = `${escapeRegExp(key.zh)}|${escapeRegExp(key.en)}`;
  const bulletMatch = normalized.match(
    new RegExp(`^\\\\s*-\\\\s*(?:${label})\\\\s*[:：]\\\\s*(.+)\\\\s*$`, "m"),
  );
  const tableMatch = normalized.match(
    new RegExp(
      `^\\\\s*\\\\|\\\\s*(?:${label})\\\\s*\\\\|\\\\s*([^|\\\\n]+?)\\\\s*\\\\|`,
      "m",
    ),
  );
  const value = (bulletMatch?.[1] ?? tableMatch?.[1] ?? "").trim();
  return value ? clampText(value, 200) : null;
}

export function clampText(text: string, maxLen: number): string {
  const normalized = text.trim();
  if (!normalized) {
    return "";
  }
  return normalized.length > maxLen
    ? `${normalized.slice(0, maxLen)}…`
    : normalized;
}

export function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function isWorldShowcaseCoverIntent(text: string): boolean {
  const normalized = text.trim();
  if (!normalized) {
    return false;
  }
  if (normalized.includes("封面")) {
    return true;
  }
  return /(^|\s)#cover(\s|$)/i.test(normalized);
}

export function pickFirstImageAttachment(
  message: Message,
): { url: string; name?: string } | null {
  if (!message.attachments || message.attachments.size === 0) {
    return null;
  }
  for (const attachment of message.attachments.values()) {
    const contentType = attachment.contentType?.toLowerCase() ?? "";
    const name = attachment.name?.toLowerCase() ?? "";
    if (contentType.startsWith("image/")) {
      return { url: attachment.url, name: attachment.name ?? undefined };
    }
    if (name.match(/\.(png|jpe?g|gif|webp)$/)) {
      return { url: attachment.url, name: attachment.name ?? undefined };
    }
  }
  return null;
}

export function extractWorldNameFromCard(card: string | null): string | null {
  const raw = (card ?? "").trim();
  if (!raw) return null;
  const normalized = raw.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const bulletMatch = normalized.match(
    /^\\s*-\\s*(?:世界名称|World Name)\\s*[:：]\\s*(.+)\\s*$/m,
  );
  const tableMatch = normalized.match(
    /^\\s*\\|\\s*(?:世界名称|World Name)\\s*\\|\\s*([^|\\n]+?)\\s*\\|/m,
  );
  const headingMatch = normalized.match(
    /^\\s*#\\s*(?:世界卡|世界观设计卡)\\s*[:：]\\s*(.+)\\s*$/m,
  );
  const name = (
    bulletMatch?.[1] ??
    tableMatch?.[1] ??
    headingMatch?.[1] ??
    ""
  ).trim();
  if (!name) return null;
  return name.length > 60 ? name.slice(0, 60) : name;
}

export function extractCharacterNameFromCard(
  card: string | null,
): string | null {
  const raw = (card ?? "").trim();
  if (!raw) return null;
  const normalized = raw.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const bulletMatch = normalized.match(
    /^\s*-\s*(?:角色名|Name)\s*[:：]\s*(.+)\s*$/m,
  );
  const tableMatch = normalized.match(
    /^\s*\|\s*(?:角色名|Name)\s*\|\s*([^|\n]+?)\s*\|/m,
  );
  const headingMatch = normalized.match(
    /^\s*#\s*(?:角色卡|Character Card)\s*[:：]\s*(.+)\s*$/m,
  );
  const name = (
    bulletMatch?.[1] ??
    tableMatch?.[1] ??
    headingMatch?.[1] ??
    ""
  ).trim();
  if (!name) return null;
  return name.length > 60 ? name.slice(0, 60) : name;
}

export function splitDiscordMessage(input: string, maxLen: number): string[] {
  const normalized = input.trim();
  if (!normalized) {
    return [];
  }
  const chunks: string[] = [];
  let remaining = normalized;
  while (remaining.length > maxLen) {
    const slice = remaining.slice(0, maxLen);
    const lastNewline = slice.lastIndexOf("\n");
    const splitAt = lastNewline > 400 ? lastNewline : maxLen;
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).trimStart();
  }
  if (remaining) {
    chunks.push(remaining);
  }
  return chunks;
}

export function truncateDiscordLabel(text: string, maxLen: number): string {
  const normalized = String(text ?? "")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) {
    return "";
  }
  if (normalized.length <= maxLen) {
    return normalized;
  }
  if (maxLen <= 1) {
    return "…";
  }
  return `${normalized.slice(0, maxLen - 1)}…`;
}
