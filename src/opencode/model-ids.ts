export const OPENCODE_MODEL_ID_EXAMPLE = "vol/glm-4.7";

export const OPENCODE_MODELS_EMPTY_ERROR = `OPENCODE_MODELS must include at least one model id (e.g. ${OPENCODE_MODEL_ID_EXAMPLE})`;

export function parseOpencodeModelIdsCsv(value: string): string[] {
  const models = value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);

  return Array.from(new Set(models));
}

export function sanitizeOpencodeModelIdOverride(
  value: string | undefined,
): string | null {
  const trimmed = value?.trim();
  if (!trimmed) {
    return null;
  }
  return trimmed;
}

export function selectOpencodeModelId(
  allowedModelIds: readonly string[],
  override: string | undefined,
): string {
  if (allowedModelIds.length === 0) {
    throw new Error(OPENCODE_MODELS_EMPTY_ERROR);
  }
  const requested = sanitizeOpencodeModelIdOverride(override);
  if (requested && allowedModelIds.includes(requested)) {
    return requested;
  }
  return allowedModelIds[0];
}
