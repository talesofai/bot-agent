type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export type JsonTextExtraction = {
  extracted: string;
  kind: "entries" | "generic";
};

export function extractTextFromJsonDocument(
  input: string,
): JsonTextExtraction | null {
  const trimmed = input.trim();
  if (!trimmed) {
    return null;
  }

  let parsed: JsonValue;
  try {
    parsed = JSON.parse(trimmed) as JsonValue;
  } catch {
    return null;
  }

  const entriesExtracted = extractEntriesPayload(parsed);
  if (entriesExtracted) {
    return { extracted: entriesExtracted, kind: "entries" };
  }

  const segments = collectTextFromJson(parsed, {
    maxSegments: 80,
    maxTotalChars: 80_000,
  });
  const extracted = segments.join("\n\n").trim();
  if (!extracted) {
    return null;
  }
  return { extracted, kind: "generic" };
}

function extractEntriesPayload(value: JsonValue): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const entriesRaw = (value as { entries?: unknown }).entries;
  if (
    !entriesRaw ||
    typeof entriesRaw !== "object" ||
    Array.isArray(entriesRaw)
  ) {
    return null;
  }

  const sections: string[] = [];
  for (const entry of Object.values(entriesRaw as Record<string, unknown>)) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const record = entry as Record<string, unknown>;
    const comment =
      typeof record["comment"] === "string" ? record["comment"].trim() : "";
    const content =
      typeof record["content"] === "string" ? record["content"].trim() : "";
    if (!content) {
      continue;
    }
    sections.push(comment ? `## ${comment}\n\n${content}` : content);
    if (sections.length >= 60) {
      break;
    }
  }

  const extracted = sections.join("\n\n").trim();
  return extracted ? extracted : null;
}

function collectTextFromJson(
  value: JsonValue,
  options: { maxSegments: number; maxTotalChars: number },
): string[] {
  const results: string[] = [];
  const seen = new Set<string>();
  const allowedKeys = new Set([
    "content",
    "text",
    "prompt",
    "description",
    "body",
    "markdown",
    "md",
    "title",
  ]);
  let total = 0;

  const walk = (node: JsonValue, keyHint: string | null): void => {
    if (
      results.length >= options.maxSegments ||
      total >= options.maxTotalChars
    ) {
      return;
    }
    if (node === null) {
      return;
    }
    if (typeof node === "string") {
      const normalized = node.trim();
      if (!normalized) {
        return;
      }
      if (keyHint && !allowedKeys.has(keyHint)) {
        return;
      }
      if (normalized.length < 12) {
        return;
      }
      if (seen.has(normalized)) {
        return;
      }
      seen.add(normalized);
      results.push(normalized);
      total += normalized.length;
      return;
    }
    if (typeof node === "number" || typeof node === "boolean") {
      return;
    }
    if (Array.isArray(node)) {
      for (const item of node) {
        walk(item, keyHint);
        if (
          results.length >= options.maxSegments ||
          total >= options.maxTotalChars
        ) {
          break;
        }
      }
      return;
    }
    for (const [key, child] of Object.entries(node)) {
      walk(child, key);
      if (
        results.length >= options.maxSegments ||
        total >= options.maxTotalChars
      ) {
        break;
      }
    }
  };

  walk(value, null);
  return results;
}
