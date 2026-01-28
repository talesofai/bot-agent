import type { HistoryEntry } from "../types/session";

export interface OpencodeStreamEvent {
  type: string;
  text: string;
}

export interface OpencodeRunResult {
  output?: string;
  historyEntries?: HistoryEntry[];
  streamEvents?: OpencodeStreamEvent[];
  rawStdout?: string;
  rawStderr?: string;
  /**
   * Hint from runner that the current opencode session is stuck (e.g. waiting for
   * an interactive UI tool) and should be reset before the next turn.
   */
  resetOpencodeSession?: boolean;
}

export function parseOpencodeOutput(
  raw: string,
  createdAt: string,
): OpencodeRunResult | null {
  if (!raw) {
    return null;
  }
  const candidates = parseJsonCandidates(raw.trim());
  const streamEvents = extractStreamEvents(candidates);
  const streamOutput = streamEvents.length
    ? streamEvents.map((event) => event.text).join("")
    : null;
  let best: OpencodeRunResult | null =
    streamOutput === null
      ? null
      : {
          output: streamOutput,
          streamEvents: streamEvents.length ? streamEvents : undefined,
        };

  for (const candidate of candidates) {
    const result = extractResult(candidate, createdAt);
    if (result) {
      best = result;
    }
  }
  if (!best) {
    return null;
  }
  if (streamEvents.length === 0) {
    return best;
  }
  return { ...best, streamEvents };
}

function parseJsonCandidates(raw: string): unknown[] {
  const direct = tryParseJson(raw);
  if (direct !== null) {
    return [direct];
  }
  const candidates: unknown[] = [];
  for (const block of scanJsonBlocks(raw)) {
    const parsed = tryParseJson(block);
    if (parsed !== null) {
      candidates.push(parsed);
    }
  }
  return candidates;
}

function extractStreamEvents(items: unknown[]): OpencodeStreamEvent[] {
  const events: OpencodeStreamEvent[] = [];
  for (const item of items) {
    if (!isRecord(item) || typeof item.type !== "string") {
      continue;
    }
    const part = isRecord(item.part) ? item.part : null;
    if (!part || typeof part.text !== "string") {
      continue;
    }
    events.push({ type: item.type, text: part.text });
  }
  return events;
}

function tryParseJson(raw: string): unknown | null {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function extractHistoryEntries(
  parsed: unknown,
  createdAt: string,
): HistoryEntry[] | null {
  if (Array.isArray(parsed)) {
    return mapEntries(parsed, createdAt);
  }
  if (isRecord(parsed)) {
    const obj = parsed;
    const message = isRecord(obj.message) ? obj.message : null;
    if (
      message &&
      typeof message.role === "string" &&
      typeof message.content === "string" &&
      isHistoryRole(message.role)
    ) {
      return [
        {
          role: message.role as HistoryEntry["role"],
          content: message.content,
          createdAt,
        },
      ];
    }
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

function extractResult(
  parsed: unknown,
  createdAt: string,
): OpencodeRunResult | null {
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

function mapEntries(items: unknown[], createdAt: string): HistoryEntry[] {
  const entries: HistoryEntry[] = [];
  for (const item of items) {
    if (!isRecord(item)) {
      continue;
    }
    const obj = item;
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
  if (isRecord(parsed)) {
    const obj = parsed;
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

function* scanJsonBlocks(raw: string): Generator<string> {
  let start = -1;
  let inString = false;
  let escaped = false;
  const stack: string[] = [];

  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i];

    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === "\\") {
        escaped = true;
        continue;
      }
      if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
      continue;
    }

    if (ch === "{" || ch === "[") {
      if (start < 0) {
        start = i;
      }
      stack.push(ch);
      continue;
    }

    if (ch === "}" || ch === "]") {
      const last = stack[stack.length - 1];
      if ((ch === "}" && last === "{") || (ch === "]" && last === "[")) {
        stack.pop();
        if (stack.length === 0 && start >= 0) {
          yield raw.slice(start, i + 1);
          start = -1;
        }
      }
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
