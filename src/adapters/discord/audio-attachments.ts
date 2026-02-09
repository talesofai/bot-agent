import { AttachmentBuilder } from "discord.js";
import type { Logger } from "pino";

import { getConfig } from "../../config";
import { createSsrfPolicy, fetchWithSsrfProtection } from "../../utils/ssrf";

const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_FILES = 2;

const DISCORD_CDN_HOSTS = new Set([
  "cdn.discordapp.com",
  "media.discordapp.net",
]);

const AUDIO_EXTENSIONS = new Set([
  ".mp3",
  ".wav",
  ".ogg",
  ".m4a",
  ".aac",
  ".flac",
  ".opus",
  ".oga",
]);

type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

type FetchAudioAttachmentResult =
  | { kind: "attachment"; attachment: AttachmentBuilder }
  | { kind: "keep" };

export async function resolveDiscordAudioAttachments(
  urls: ReadonlyArray<string>,
  options?: {
    maxBytes?: number;
    timeoutMs?: number;
    maxFiles?: number;
    fetchFn?: FetchFn;
    logger?: Pick<Logger, "debug" | "warn">;
  },
): Promise<{ files: AttachmentBuilder[]; keptUrls: string[] }> {
  const ssrfPolicy = createSsrfPolicy(getConfig());
  const maxBytes = options?.maxBytes ?? DEFAULT_MAX_BYTES;
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxFiles = options?.maxFiles ?? DEFAULT_MAX_FILES;
  const fetchFn: FetchFn =
    options?.fetchFn ?? ((input, init) => fetch(input, init));
  const logger = options?.logger;

  const files: AttachmentBuilder[] = [];
  const keptUrls: string[] = [];
  const seen = new Set<string>();

  for (const url of urls) {
    const normalized = url.trim();
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);

    if (files.length >= maxFiles) {
      keptUrls.push(normalized);
      continue;
    }

    const parsed = safeParseHttpUrl(normalized);
    if (!parsed) {
      keptUrls.push(normalized);
      continue;
    }

    if (DISCORD_CDN_HOSTS.has(parsed.hostname)) {
      keptUrls.push(normalized);
      continue;
    }

    const attachment = await fetchAudioAttachment(parsed, {
      maxBytes,
      timeoutMs,
      fetchFn,
      filenameHint: `audio-${files.length + 1}`,
      ssrfPolicy,
    }).catch((err) => {
      logger?.debug?.({ err, url: normalized }, "Failed to fetch audio");
      return { kind: "keep" } as const;
    });

    if (attachment.kind === "keep") {
      keptUrls.push(normalized);
      continue;
    }

    files.push(attachment.attachment);
  }

  return { files, keptUrls };
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

async function fetchAudioAttachment(
  url: URL,
  options: {
    maxBytes: number;
    timeoutMs: number;
    fetchFn: FetchFn;
    filenameHint: string;
    ssrfPolicy: ReturnType<typeof createSsrfPolicy>;
  },
): Promise<FetchAudioAttachmentResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs);
  try {
    const { response, url: finalUrl } = await fetchWithSsrfProtection(
      url,
      {
        redirect: "manual",
        signal: controller.signal,
        headers: {
          accept: "audio/*,*/*;q=0.8",
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

    const contentType = (response.headers.get("content-type") ?? "")
      .split(";")[0]
      ?.trim()
      .toLowerCase();
    const extFromPath = extensionFromPathname(finalUrl.pathname);
    const hasAudioType = Boolean(
      contentType && contentType.startsWith("audio/"),
    );
    const hasAudioExt = Boolean(
      extFromPath && AUDIO_EXTENSIONS.has(extFromPath),
    );
    const isGenericBinary = contentType === "application/octet-stream";
    if (contentType) {
      if (!hasAudioType && !(isGenericBinary && hasAudioExt)) {
        return { kind: "keep" };
      }
    } else if (!hasAudioExt) {
      return { kind: "keep" };
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.byteLength === 0 || buffer.byteLength > options.maxBytes) {
      return { kind: "keep" };
    }

    const filename = resolveFilename({
      url: finalUrl,
      contentType: contentType ?? "",
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

function extensionFromPathname(pathname: string): string | null {
  const basename = pathname.split("/").filter(Boolean).pop() ?? "";
  const idx = basename.lastIndexOf(".");
  if (idx <= 0 || idx === basename.length - 1) {
    return null;
  }
  return basename.slice(idx).toLowerCase();
}

function resolveFilename(input: {
  url: URL;
  contentType: string;
  fallback: string;
}): string {
  const basename = input.url.pathname.split("/").filter(Boolean).pop();
  const extFromType = extensionFromContentType(input.contentType);
  const extFromPath = extensionFromPathname(input.url.pathname);
  const resolvedExt =
    extFromType ??
    (extFromPath && AUDIO_EXTENSIONS.has(extFromPath) ? extFromPath : null) ??
    ".mp3";

  if (basename && basename.length <= 64 && /^[a-zA-Z0-9._-]+$/.test(basename)) {
    const idx = basename.lastIndexOf(".");
    if (idx > 0 && idx < basename.length - 1) {
      const ext = basename.slice(idx).toLowerCase();
      if (AUDIO_EXTENSIONS.has(ext)) {
        return basename;
      }
      const stem = basename.slice(0, idx);
      return `${stem}${resolvedExt}`;
    }
    return `${basename}${resolvedExt}`;
  }

  return `${input.fallback}${resolvedExt}`;
}

function extensionFromContentType(contentType: string): string | null {
  const lowered = contentType.toLowerCase();
  if (lowered.includes("audio/mpeg")) {
    return ".mp3";
  }
  if (lowered.includes("audio/wav") || lowered.includes("audio/x-wav")) {
    return ".wav";
  }
  if (lowered.includes("audio/ogg")) {
    return ".ogg";
  }
  if (lowered.includes("audio/mp4") || lowered.includes("audio/m4a")) {
    return ".m4a";
  }
  if (lowered.includes("audio/aac")) {
    return ".aac";
  }
  if (lowered.includes("audio/flac")) {
    return ".flac";
  }
  if (lowered.includes("audio/opus")) {
    return ".opus";
  }
  return null;
}
