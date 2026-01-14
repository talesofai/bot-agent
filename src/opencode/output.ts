import type { HistoryEntry } from "../types/session";

export interface OpencodeRunResult {
  output?: string;
  historyEntries?: HistoryEntry[];
}

export function parseOpencodeOutput(
  raw: string,
  createdAt: string,
): OpencodeRunResult | null {
  if (!raw) {
    return null;
  }
  const parsed = tryParseJson(raw.trim());
  if (!parsed) {
    return null;
  }
  const entries = extractHistoryEntries(parsed, createdAt);
  const output = extractOutput(parsed, entries);
  if (output === null && (!entries || entries.length === 0)) {
    return null;
  }
  return {
    output: output ?? undefined,
    historyEntries: entries && entries.length > 0 ? entries : undefined,
  };
}

function tryParseJson(raw: string | null): unknown | null {
  if (!raw) {
    return null;
  }
  try {
    return JSON.parse(raw);
  } catch {
    return parseJsonFromLines(raw);
  }
}

function parseJsonFromLines(raw: string): unknown | null {
  const lines = raw.split(/\r?\n/);
  const nonEmpty = lines.filter((line) => line.trim().length > 0);
  if (nonEmpty.length === 0) {
    return null;
  }

  const tryParse = (candidate: string): unknown | null => {
    if (!candidate) {
      return null;
    }
    try {
      return JSON.parse(candidate);
    } catch {
      return null;
    }
  };

  for (let start = 0; start < nonEmpty.length; start += 1) {
    let candidate = "";
    for (let end = start; end < nonEmpty.length; end += 1) {
      candidate = candidate ? `${candidate}\n${nonEmpty[end]}` : nonEmpty[end];
      const parsed = tryParse(candidate.trim());
      if (parsed) {
        return parsed;
      }
    }
  }
  return null;
}

function extractHistoryEntries(
  parsed: unknown,
  createdAt: string,
): HistoryEntry[] | null {
  if (Array.isArray(parsed)) {
    return mapEntries(parsed, createdAt);
  }
  if (parsed && typeof parsed === "object") {
    const obj = parsed as Record<string, unknown>;
    const candidates =
      (Array.isArray(obj.messages) && obj.messages) ||
      (Array.isArray(obj.history) && obj.history) ||
      null;
    if (candidates) {
      return mapEntries(candidates, createdAt);
    }
    if (
      typeof obj.role === "string" &&
      typeof obj.content === "string" &&
      isHistoryRole(obj.role)
    ) {
      return [
        {
          role: obj.role as HistoryEntry["role"],
          content: obj.content,
          createdAt,
        },
      ];
    }
  }
  return null;
}

function mapEntries(items: unknown[], createdAt: string): HistoryEntry[] {
  const entries: HistoryEntry[] = [];
  for (const item of items) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const obj = item as Record<string, unknown>;
    if (typeof obj.role !== "string" || typeof obj.content !== "string") {
      continue;
    }
    if (!isHistoryRole(obj.role)) {
      continue;
    }
    entries.push({
      role: obj.role,
      content: obj.content,
      createdAt,
    });
  }
  return entries;
}

function isHistoryRole(role: string): role is HistoryEntry["role"] {
  return role === "user" || role === "assistant" || role === "system";
}

function extractOutput(
  parsed: unknown,
  entries: HistoryEntry[] | null,
): string | null {
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    const obj = parsed as Record<string, unknown>;
    if (typeof obj.output === "string") {
      return obj.output;
    }
    if (typeof obj.content === "string") {
      return obj.content;
    }
  }
  if (entries && entries.length > 0) {
    const lastAssistant = [...entries]
      .reverse()
      .find((entry) => entry.role === "assistant");
    return lastAssistant?.content ?? null;
  }
  return null;
}
