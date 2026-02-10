import type { SessionElement } from "../types/platform";

const DEFAULT_MAX_IMAGES = 4;
const MARKDOWN_IMAGE_PATTERN = /!\[[^\]]*]\(\s*(https?:\/\/[^\s)]+)\s*\)/g;
const URL_PATTERN = /https?:\/\/[^\s<>()]+/g;
const IMAGE_EXTENSIONS = [".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"];
const COMMAND_ACTIONS_PATTERN = /```command-actions\s*([\s\S]*?)```/gi;
const MAX_COMMAND_ACTIONS = 5;

export type CommandActionType =
  | "help"
  | "character_create"
  | "world_create"
  | "world_list"
  | "world_show"
  | "character_show"
  | "world_join";

export type CommandActionSuggestion = {
  action: CommandActionType;
  label?: string;
  payload?: string;
};

export type CommandActionsBlock = {
  prompt?: string;
  actions: CommandActionSuggestion[];
};

export function extractOutputElements(
  output: string,
  options?: { maxImages?: number },
): {
  content: string;
  elements: SessionElement[];
  commandActions: CommandActionsBlock | null;
} {
  const maxImages = options?.maxImages ?? DEFAULT_MAX_IMAGES;
  if (!output.trim()) {
    return { content: "", elements: [], commandActions: null };
  }

  const { contentWithoutBlocks, commandActions } =
    extractCommandActions(output);
  const imageUrls: string[] = [];
  const content = stripMarkdownImages(
    contentWithoutBlocks,
    imageUrls,
    maxImages,
  )
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  for (const match of contentWithoutBlocks.matchAll(URL_PATTERN)) {
    if (imageUrls.length >= maxImages) {
      break;
    }
    const candidate = normalizeUrlCandidate(match[0]);
    if (!candidate) {
      continue;
    }
    if (!isImageUrl(candidate)) {
      continue;
    }
    if (imageUrls.includes(candidate)) {
      continue;
    }
    imageUrls.push(candidate);
  }

  return {
    content,
    elements: imageUrls.map((url) => ({ type: "image", url })),
    commandActions,
  };
}

function extractCommandActions(output: string): {
  contentWithoutBlocks: string;
  commandActions: CommandActionsBlock | null;
} {
  let commandActions: CommandActionsBlock | null = null;
  const contentWithoutBlocks = output.replace(
    COMMAND_ACTIONS_PATTERN,
    (_match: string, payloadText: string) => {
      if (!commandActions) {
        commandActions = parseCommandActionsBlock(payloadText);
      }
      return "";
    },
  );
  return { contentWithoutBlocks, commandActions };
}

function parseCommandActionsBlock(
  payloadText: string,
): CommandActionsBlock | null {
  const trimmed = payloadText.trim();
  if (!trimmed) {
    return null;
  }

  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (!parsed || typeof parsed !== "object") {
      return null;
    }

    const record = parsed as Record<string, unknown>;
    const prompt =
      typeof record.prompt === "string" && record.prompt.trim()
        ? record.prompt.trim()
        : undefined;
    const actionsRaw = record.actions;
    if (!Array.isArray(actionsRaw)) {
      return null;
    }

    const actions: CommandActionSuggestion[] = [];
    const seen = new Set<string>();
    for (const rawItem of actionsRaw) {
      if (!rawItem || typeof rawItem !== "object") {
        continue;
      }
      const item = rawItem as Record<string, unknown>;
      const rawAction =
        typeof item.action === "string" ? item.action.trim() : "";
      if (!isCommandActionType(rawAction)) {
        continue;
      }

      const rawPayload =
        typeof item.payload === "string" ? item.payload.trim() : "";
      const payload = rawPayload || undefined;
      if (requiresNumericPayload(rawAction)) {
        if (!payload || !/^[1-9]\d*$/.test(payload)) {
          continue;
        }
      }

      const rawLabel = typeof item.label === "string" ? item.label.trim() : "";
      const label = rawLabel ? rawLabel : undefined;

      const dedupeKey = `${rawAction}:${payload ?? ""}`;
      if (seen.has(dedupeKey)) {
        continue;
      }
      seen.add(dedupeKey);

      actions.push(
        payload
          ? { action: rawAction, payload, label }
          : { action: rawAction, label },
      );

      if (actions.length >= MAX_COMMAND_ACTIONS) {
        break;
      }
    }

    if (actions.length === 0) {
      return null;
    }
    return { prompt, actions };
  } catch {
    return null;
  }
}

function isCommandActionType(value: string): value is CommandActionType {
  return (
    value === "help" ||
    value === "character_create" ||
    value === "world_create" ||
    value === "world_list" ||
    value === "world_show" ||
    value === "character_show" ||
    value === "world_join"
  );
}

function requiresNumericPayload(action: CommandActionType): boolean {
  return (
    action === "world_show" ||
    action === "character_show" ||
    action === "world_join"
  );
}

function stripMarkdownImages(
  content: string,
  imageUrls: string[],
  maxImages: number,
): string {
  return content.replace(
    MARKDOWN_IMAGE_PATTERN,
    (_match: string, url: string) => {
      const candidate = normalizeUrlCandidate(url);
      if (!candidate) {
        return _match;
      }
      if (imageUrls.includes(candidate)) {
        return "";
      }
      if (imageUrls.length >= maxImages) {
        return candidate;
      }
      imageUrls.push(candidate);
      return "";
    },
  );
}

function normalizeUrlCandidate(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  const cleaned = trimmed.replace(/[)\],.!?]+$/g, "");
  if (!cleaned) {
    return null;
  }
  try {
    const url = new URL(cleaned);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return null;
    }
  } catch {
    return null;
  }
  return cleaned;
}

function isImageUrl(value: string): boolean {
  try {
    const url = new URL(value);
    const pathname = url.pathname.toLowerCase();
    return IMAGE_EXTENSIONS.some((ext) => pathname.endsWith(ext));
  } catch {
    return false;
  }
}
