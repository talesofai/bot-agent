export const ALLOWED_DISCORD_IMAGE_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".webp",
  ".gif",
  ".bmp",
]);

export function buildWorldWikiLinks(input: {
  worldId: number;
  baseUrl?: string | null;
}): { zhWorldCard: string; enWorldCard: string } | null {
  if (!Number.isInteger(input.worldId) || input.worldId <= 0) {
    return null;
  }
  const wikiBase = normalizeWikiPublicBaseUrl(input.baseUrl);
  if (!wikiBase) {
    return null;
  }

  const worldSegment = `worlds/W${input.worldId}/world-card.md`;
  return {
    zhWorldCard: new URL(`zh/#/${worldSegment}`, wikiBase).toString(),
    enWorldCard: new URL(`en/#/${worldSegment}`, wikiBase).toString(),
  };
}

export function normalizeWikiPublicBaseUrl(
  raw: string | null | undefined,
): URL | null {
  const trimmed = raw?.trim() ?? "";
  if (!trimmed) {
    return null;
  }

  try {
    const base = new URL(trimmed);
    const pathname = base.pathname.replace(/\/+$/, "");
    const wikiIndex = pathname.indexOf("/wiki");

    let wikiPath = "";
    if (wikiIndex >= 0) {
      wikiPath = pathname.slice(0, wikiIndex + "/wiki".length);
    } else if (!pathname || pathname === "/") {
      wikiPath = "/wiki";
    } else {
      wikiPath = `${pathname}/wiki`;
    }

    base.pathname = `${wikiPath}/`;
    base.search = "";
    base.hash = "";
    return base;
  } catch {
    return null;
  }
}

export function safeParseHttpUrl(value: string): URL | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return null;
    }
    return url;
  } catch {
    return null;
  }
}

export function extensionFromFilename(filename: string): string | null {
  const basename = filename.split("/").pop()?.trim() ?? "";
  const idx = basename.lastIndexOf(".");
  if (idx <= 0 || idx === basename.length - 1) {
    return null;
  }
  return basename.slice(idx).toLowerCase();
}

export function isAllowedWikiImportFilename(filename: string): boolean {
  const trimmed = filename.trim().toLowerCase();
  return (
    trimmed.endsWith(".md") ||
    trimmed.endsWith(".markdown") ||
    trimmed.endsWith(".txt")
  );
}

export function resolveCanonImportFilename(
  worldId: number,
  rawFilename: string,
): string {
  const trimmed = rawFilename.trim();
  if (!trimmed) {
    return "";
  }
  const prefix = `W${worldId}-`;
  if (trimmed.startsWith(prefix)) {
    return trimmed.slice(prefix.length).trim();
  }
  return trimmed;
}
