import type { APIEmbed } from "discord.js";

const DISCORD_EMBED_TITLE_MAX_LEN = 256;
const DISCORD_EMBED_DESCRIPTION_MAX_LEN = 4096;
const DISCORD_EMBED_FIELD_NAME_MAX_LEN = 256;
const DISCORD_EMBED_FIELD_VALUE_MAX_LEN = 1024;
const DISCORD_EMBED_FIELDS_MAX = 25;

type MarkdownSection = {
  title: string;
  level: number;
  body: string;
};

type KeyValuePair = { key: string; value: string };

export type BuildMarkdownCardEmbedsOptions = {
  titlePrefix: string;
  maxEmbeds?: number;
  includeEmptyFields?: boolean;
};

export function chunkEmbedsForDiscord(
  embeds: APIEmbed[],
  maxPerMessage = 10,
): APIEmbed[][] {
  const safeMax = Math.max(1, Math.min(10, Math.floor(maxPerMessage)));
  const chunks: APIEmbed[][] = [];
  for (let i = 0; i < embeds.length; i += safeMax) {
    chunks.push(embeds.slice(i, i + safeMax));
  }
  return chunks;
}

export function buildMarkdownCardEmbeds(
  markdown: string,
  options: BuildMarkdownCardEmbedsOptions,
): APIEmbed[] {
  const titlePrefix = options.titlePrefix.trim();
  const maxEmbeds = Math.max(1, options.maxEmbeds ?? 18);
  const includeEmptyFields = options.includeEmptyFields ?? true;

  const normalized = normalizeNewlines(markdown).trim();
  if (!normalized) {
    return [
      {
        title: truncateInline(
          titlePrefix || "内容",
          DISCORD_EMBED_TITLE_MAX_LEN,
        ),
        description: "(缺失)",
      },
    ];
  }

  const sections = parseMarkdownSections(normalized);
  const embeds: APIEmbed[] = [];
  let truncated = false;

  for (const section of sections) {
    if (embeds.length >= maxEmbeds) {
      truncated = true;
      break;
    }

    const { pairs, notes } = extractPairsAndNotes(section.body);
    const fields = buildFieldsFromPairs(pairs, includeEmptyFields);
    const sectionTitle = buildSectionTitle(titlePrefix, section.title);

    if (fields.length === 0) {
      const plain = notes.trim();
      if (!plain) {
        continue;
      }
      const parts = splitTextForDiscord(
        plain,
        DISCORD_EMBED_DESCRIPTION_MAX_LEN,
      );
      for (let i = 0; i < parts.length; i += 1) {
        if (embeds.length >= maxEmbeds) {
          truncated = true;
          break;
        }
        embeds.push({
          title: truncateInline(
            parts.length > 1
              ? `${sectionTitle}（${i + 1}/${parts.length}）`
              : sectionTitle,
            DISCORD_EMBED_TITLE_MAX_LEN,
          ),
          description: parts[i],
        });
      }
      if (truncated) break;
      continue;
    }

    const notePreview = notes.trim()
      ? truncateDiscordEmbedDescription(
          notes.trim(),
          DISCORD_EMBED_DESCRIPTION_MAX_LEN,
        )
      : { text: "", truncated: false };

    const fieldGroups = chunkArray(fields, DISCORD_EMBED_FIELDS_MAX);
    for (let groupIndex = 0; groupIndex < fieldGroups.length; groupIndex += 1) {
      if (embeds.length >= maxEmbeds) {
        truncated = true;
        break;
      }
      embeds.push({
        title: truncateInline(
          fieldGroups.length > 1
            ? `${sectionTitle}（${groupIndex + 1}/${fieldGroups.length}）`
            : sectionTitle,
          DISCORD_EMBED_TITLE_MAX_LEN,
        ),
        description:
          groupIndex === 0 && notePreview.text ? notePreview.text : undefined,
        fields: fieldGroups[groupIndex],
        footer:
          groupIndex === fieldGroups.length - 1 && notePreview.truncated
            ? { text: "内容过长，部分已省略" }
            : undefined,
      });
    }
    if (truncated) break;
  }

  if (truncated && embeds.length > 0) {
    const last = embeds[embeds.length - 1];
    if (!last.footer) {
      last.footer = { text: "内容过长，后续已省略" };
    }
  }

  return embeds;
}

function normalizeNewlines(input: string): string {
  return input.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function parseMarkdownSections(markdown: string): MarkdownSection[] {
  const lines = normalizeNewlines(markdown).split("\n");
  const sections: Array<{
    title: string;
    level: number;
    lines: string[];
  }> = [];

  let current: { title: string; level: number; lines: string[] } = {
    title: "",
    level: 0,
    lines: [],
  };

  for (const line of lines) {
    const match = line.match(/^\s*(#{1,6})\s+(.+?)\s*$/);
    if (match) {
      if (current.title.trim() || current.lines.some((l) => l.trim())) {
        sections.push(current);
      }
      current = {
        title: match[2] ?? "",
        level: match[1]?.length ?? 1,
        lines: [],
      };
      continue;
    }
    current.lines.push(line);
  }

  if (current.title.trim() || current.lines.some((l) => l.trim())) {
    sections.push(current);
  }

  return sections
    .map((section) => ({
      title: section.title.trim(),
      level: section.level,
      body: section.lines.join("\n").trim(),
    }))
    .filter((section) => section.title || section.body);
}

function extractPairsAndNotes(body: string): {
  pairs: KeyValuePair[];
  notes: string;
} {
  const lines = normalizeNewlines(body).split("\n");
  const pairs: KeyValuePair[] = [];
  const notes: string[] = [];

  let inCodeBlock = false;
  for (const rawLine of lines) {
    const line = rawLine ?? "";
    const trimmed = line.trim();

    if (trimmed.startsWith("```")) {
      inCodeBlock = !inCodeBlock;
      notes.push(line);
      continue;
    }
    if (inCodeBlock) {
      notes.push(line);
      continue;
    }

    if (isMarkdownSeparatorLine(trimmed)) {
      continue;
    }

    const bulletMatch = line.match(/^\s*[-*]\s+(.+?)\s*[:：]\s*(.*)\s*$/);
    if (bulletMatch) {
      const key = (bulletMatch[1] ?? "").trim();
      const value = (bulletMatch[2] ?? "").trim();
      if (key) {
        pairs.push({ key, value });
        continue;
      }
    }

    const tableMatch = line.match(/^\s*\|\s*([^|]+?)\s*\|\s*([^|]*?)\s*\|/);
    if (tableMatch) {
      const key = (tableMatch[1] ?? "").trim();
      const value = (tableMatch[2] ?? "").trim();
      if (key && !isMarkdownTableSeparatorCell(key)) {
        pairs.push({ key, value });
        continue;
      }
    }

    notes.push(line);
  }

  return { pairs, notes: notes.join("\n").trim() };
}

function buildFieldsFromPairs(
  pairs: KeyValuePair[],
  includeEmptyFields: boolean,
): Array<{ name: string; value: string; inline?: boolean }> {
  const fields: Array<{ name: string; value: string; inline?: boolean }> = [];
  for (const pair of pairs) {
    const key = pair.key.trim();
    if (!key) continue;

    const rawValue = pair.value.trim();
    const value = rawValue || (includeEmptyFields ? "（未填写）" : "");
    if (!value) continue;

    const nameBase = truncateInline(key, DISCORD_EMBED_FIELD_NAME_MAX_LEN);
    const chunks = splitTextForDiscord(
      value,
      DISCORD_EMBED_FIELD_VALUE_MAX_LEN,
    );
    if (chunks.length === 0) {
      fields.push({ name: nameBase, value: "（空）", inline: false });
      continue;
    }
    if (chunks.length === 1) {
      fields.push({ name: nameBase, value: chunks[0], inline: false });
      continue;
    }

    for (let i = 0; i < chunks.length; i += 1) {
      const name = truncateInline(
        `${nameBase}（${i + 1}/${chunks.length}）`,
        DISCORD_EMBED_FIELD_NAME_MAX_LEN,
      );
      fields.push({ name, value: chunks[i], inline: false });
    }
  }
  return fields;
}

function buildSectionTitle(prefix: string, sectionTitle: string): string {
  const safePrefix = prefix.trim() || "内容";
  const safeSection = sectionTitle.trim();
  if (!safeSection) {
    return safePrefix;
  }
  if (safeSection === safePrefix || safeSection.startsWith(safePrefix)) {
    return safeSection;
  }
  return `${safePrefix} · ${safeSection}`;
}

function truncateInline(input: string, maxLen: number): string {
  const normalized = input.trim();
  if (!normalized) return "";
  if (normalized.length <= maxLen) return normalized;
  if (maxLen <= 1) return normalized.slice(0, maxLen);
  return `${normalized.slice(0, maxLen - 1)}…`;
}

function splitTextForDiscord(input: string, maxLen: number): string[] {
  const normalized = input.trim();
  if (!normalized) return [];

  const chunks: string[] = [];
  let remaining = normalized;
  while (remaining.length > maxLen) {
    const slice = remaining.slice(0, maxLen);
    const lastNewline = slice.lastIndexOf("\n");
    const splitAt =
      lastNewline > Math.floor(maxLen * 0.4) ? lastNewline : maxLen;
    chunks.push(remaining.slice(0, splitAt).trimEnd());
    remaining = remaining.slice(splitAt).trimStart();
  }
  if (remaining) {
    chunks.push(remaining);
  }
  return chunks;
}

function truncateDiscordEmbedDescription(
  input: string,
  maxLen: number,
): { text: string; truncated: boolean } {
  const normalized = input.trim();
  if (!normalized) {
    return { text: "", truncated: false };
  }
  if (normalized.length <= maxLen) {
    return { text: normalized, truncated: false };
  }

  const ellipsis = "\n\n…";
  const budget = Math.max(0, maxLen - ellipsis.length);
  const slice = normalized.slice(0, budget);
  const lastNewline = slice.lastIndexOf("\n");
  const cutAt = lastNewline > 400 ? lastNewline : slice.length;
  const text = normalized.slice(0, cutAt).trimEnd();
  return { text: `${text}${ellipsis}`, truncated: true };
}

function isMarkdownSeparatorLine(trimmedLine: string): boolean {
  if (!trimmedLine) {
    return false;
  }
  if (/^[-*_]{3,}$/.test(trimmedLine)) {
    return true;
  }
  return /^\|?[\s:|-]{3,}\|?$/.test(trimmedLine);
}

function isMarkdownTableSeparatorCell(value: string): boolean {
  const normalized = value.trim();
  if (!normalized) {
    return false;
  }
  return /^:?-{2,}:?$/.test(normalized);
}

function chunkArray<T>(items: T[], size: number): T[][] {
  const safeSize = Math.max(1, Math.floor(size));
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += safeSize) {
    chunks.push(items.slice(i, i + safeSize));
  }
  return chunks;
}
