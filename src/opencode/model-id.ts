export const OPENCODE_MODELS_DOC =
  "OPENCODE_MODELS（逗号分隔“裸模型名”，会内部拼成 litellm/<name>）";

export type OpencodeModelsCsvError =
  | { kind: "missing" }
  | { kind: "invalid_model_id"; modelId: string };

export type OpencodeModelsCsvResult =
  | { ok: true; models: string[] }
  | { ok: false; error: OpencodeModelsCsvError };

export function isBareOpencodeModelId(value: string): boolean {
  const trimmed = value.trim();
  return trimmed.length > 0 && !trimmed.includes("/");
}

export function sanitizeOpencodeModelId(
  value: string | null | undefined,
): string | null {
  if (!value) {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  return isBareOpencodeModelId(trimmed) ? trimmed : null;
}

export function parseOpencodeModelsCsv(
  value: string | null | undefined,
): OpencodeModelsCsvResult {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) {
    return { ok: false, error: { kind: "missing" } };
  }

  const entries = trimmed
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (entries.length === 0) {
    return { ok: false, error: { kind: "missing" } };
  }

  const unique = new Set<string>();
  for (const entry of entries) {
    if (!isBareOpencodeModelId(entry)) {
      return { ok: false, error: { kind: "invalid_model_id", modelId: entry } };
    }
    unique.add(entry);
  }

  return { ok: true, models: Array.from(unique) };
}

export function formatOpencodeModelsCsvError(
  error: OpencodeModelsCsvError,
): string {
  switch (error.kind) {
    case "missing": {
      return `${OPENCODE_MODELS_DOC} 不能为空。`;
    }
    case "invalid_model_id": {
      return `${OPENCODE_MODELS_DOC} 配置无效：模型名必须是“裸模型名”（不要带 litellm/ 前缀；不要包含 /），但收到：${error.modelId}`;
    }
  }
}
