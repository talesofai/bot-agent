import { AttachmentBuilder } from "discord.js";
import type { Logger } from "pino";
import type { SessionElement } from "../../types/platform";

const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_FILES = 4;

const DISCORD_CDN_HOSTS = new Set([
  "cdn.discordapp.com",
  "media.discordapp.net",
]);

type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

export async function resolveDiscordImageAttachments(
  elements: ReadonlyArray<SessionElement>,
  options?: {
    maxBytes?: number;
    timeoutMs?: number;
    maxFiles?: number;
    fetchFn?: FetchFn;
    logger?: Pick<Logger, "debug" | "warn">;
  },
): Promise<{ elements: SessionElement[]; files: AttachmentBuilder[] }> {
  const maxBytes = options?.maxBytes ?? DEFAULT_MAX_BYTES;
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxFiles = options?.maxFiles ?? DEFAULT_MAX_FILES;
  const fetchFn: FetchFn =
    options?.fetchFn ?? ((input, init) => fetch(input, init));
  const logger = options?.logger;

  const remaining: SessionElement[] = [];
  const files: AttachmentBuilder[] = [];
  let fileIndex = 0;

  for (const element of elements) {
    if (element.type !== "image") {
      remaining.push(element);
      continue;
    }

    if (files.length >= maxFiles) {
      remaining.push(element);
      continue;
    }

    const parsed = safeParseHttpUrl(element.url);
    if (!parsed) {
      remaining.push(element);
      continue;
    }

    if (DISCORD_CDN_HOSTS.has(parsed.hostname)) {
      remaining.push(element);
      continue;
    }

    const attachment = await fetchImageAttachment(parsed, {
      maxBytes,
      timeoutMs,
      fetchFn,
      filenameHint: `image-${fileIndex + 1}`,
    }).catch((err) => {
      logger?.debug?.({ err, url: element.url }, "Failed to fetch image");
      return null;
    });

    if (!attachment) {
      remaining.push(element);
      continue;
    }

    fileIndex += 1;
    files.push(attachment);
  }

  return { elements: remaining, files };
}

function safeParseHttpUrl(value: string): URL | null {
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

async function fetchImageAttachment(
  url: URL,
  options: {
    maxBytes: number;
    timeoutMs: number;
    fetchFn: FetchFn;
    filenameHint: string;
  },
): Promise<AttachmentBuilder | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs);
  try {
    const response = await options.fetchFn(url.toString(), {
      redirect: "follow",
      signal: controller.signal,
    });
    if (!response.ok) {
      return null;
    }

    const contentLength = response.headers.get("content-length");
    if (contentLength) {
      const length = Number(contentLength);
      if (Number.isFinite(length) && length > options.maxBytes) {
        return null;
      }
    }

    const contentType = response.headers.get("content-type") ?? "";
    if (contentType && !contentType.toLowerCase().startsWith("image/")) {
      return null;
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.byteLength > options.maxBytes) {
      return null;
    }

    const filename = resolveFilename({
      url,
      contentType,
      fallback: options.filenameHint,
    });
    return new AttachmentBuilder(buffer, { name: filename });
  } finally {
    clearTimeout(timeout);
  }
}

function resolveFilename(input: {
  url: URL;
  contentType: string;
  fallback: string;
}): string {
  const basename = input.url.pathname.split("/").filter(Boolean).pop();
  if (basename && basename.length <= 64 && /^[a-zA-Z0-9._-]+$/.test(basename)) {
    return basename;
  }

  const extension = extensionFromContentType(input.contentType);
  return extension ? `${input.fallback}${extension}` : `${input.fallback}.png`;
}

function extensionFromContentType(contentType: string): string | null {
  const lowered = contentType.toLowerCase();
  if (lowered.includes("image/png")) {
    return ".png";
  }
  if (lowered.includes("image/jpeg")) {
    return ".jpg";
  }
  if (lowered.includes("image/gif")) {
    return ".gif";
  }
  if (lowered.includes("image/webp")) {
    return ".webp";
  }
  return null;
}
