import { AttachmentBuilder } from "discord.js";
import type { Logger } from "pino";
import type { SessionElement } from "../../types/platform";
import { getConfig } from "../../config";
import { createSsrfPolicy, fetchWithSsrfProtection } from "../../utils/ssrf";

const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_FILES = 4;

const DISCORD_CDN_HOSTS = new Set([
  "cdn.discordapp.com",
  "media.discordapp.net",
]);

type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

type FetchImageAttachmentResult =
  | { kind: "attachment"; attachment: AttachmentBuilder }
  | { kind: "keep" };

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
  const ssrfPolicy = createSsrfPolicy(getConfig());
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
      ssrfPolicy,
    }).catch((err) => {
      logger?.debug?.({ err, url: element.url }, "Failed to fetch image");
      return { kind: "keep" } as const;
    });

    if (attachment.kind === "keep") {
      remaining.push(element);
      continue;
    }

    fileIndex += 1;
    files.push(attachment.attachment);
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
    ssrfPolicy: ReturnType<typeof createSsrfPolicy>;
  },
): Promise<FetchImageAttachmentResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs);
  try {
    const { response, url: finalUrl } = await fetchWithSsrfProtection(
      url,
      {
        redirect: "manual",
        signal: controller.signal,
        headers: {
          accept: "image/*,*/*;q=0.8",
          "user-agent":
            "Mozilla/5.0 (compatible; opencode-bot-agent/1.0; +https://github.com/opencode-ai/opencode)",
        },
      },
      options.ssrfPolicy,
      options.fetchFn,
    );
    if (!response.ok) {
      return { kind: "keep" };
    }

    const contentLength = response.headers.get("content-length");
    if (contentLength) {
      const length = Number(contentLength);
      if (Number.isFinite(length) && length > options.maxBytes) {
        return { kind: "keep" };
      }
    }

    const contentType = response.headers.get("content-type") ?? "";
    if (contentType && !contentType.toLowerCase().startsWith("image/")) {
      return { kind: "keep" };
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.byteLength > options.maxBytes) {
      return { kind: "keep" };
    }

    const filename = resolveFilename({
      url: finalUrl,
      contentType,
      fallback: options.filenameHint,
    });
    return {
      kind: "attachment",
      attachment: new AttachmentBuilder(buffer, { name: filename }),
    };
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
    if (basename.includes(".")) {
      return basename;
    }
    const extension = extensionFromContentType(input.contentType);
    return extension ? `${basename}${extension}` : basename;
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
