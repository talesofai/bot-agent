import type { Attachment } from "discord.js";
import type { Logger } from "pino";

import { getConfig } from "../../config";
import { createSsrfPolicy, fetchWithSsrfProtection } from "../../utils/ssrf";

const DEFAULT_MAX_BYTES = 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 10_000;

const ALLOWED_EXTENSIONS = new Set([
  ".md",
  ".markdown",
  ".txt",
  ".json",
  ".yaml",
  ".yml",
]);

type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

export async function fetchDiscordTextAttachment(
  attachment: Attachment,
  options?: {
    maxBytes?: number;
    timeoutMs?: number;
    fetchFn?: FetchFn;
    logger?: Pick<Logger, "debug" | "warn">;
  },
): Promise<{ filename: string; content: string }> {
  const url = safeParseHttpUrl(attachment.url ?? "");
  if (!url) {
    throw new Error("attachment url is invalid");
  }

  const maxBytes = options?.maxBytes ?? DEFAULT_MAX_BYTES;
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fetchFn: FetchFn =
    options?.fetchFn ?? ((input, init) => fetch(input, init));
  const logger = options?.logger;

  const filename = (attachment.name ?? "").trim() || "document.txt";
  const ext = extensionFromFilename(filename);
  const contentType = normalizeContentType(attachment.contentType ?? "");

  const hasAllowedType =
    (contentType && contentType.startsWith("text/")) ||
    contentType.includes("json") ||
    contentType.includes("yaml") ||
    contentType.includes("markdown");
  const hasAllowedExt = ext ? ALLOWED_EXTENSIONS.has(ext) : false;
  if (!hasAllowedType && !hasAllowedExt) {
    throw new Error(
      `unsupported attachment type: contentType=${attachment.contentType ?? "n/a"} filename=${filename}`,
    );
  }

  const declaredSize = attachment.size;
  if (
    typeof declaredSize === "number" &&
    Number.isFinite(declaredSize) &&
    declaredSize > maxBytes
  ) {
    throw new Error(`attachment too large: ${declaredSize} > ${maxBytes}`);
  }

  const ssrfPolicy = createSsrfPolicy(getConfig());
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const { response } = await fetchWithSsrfProtection(
      url,
      {
        redirect: "manual",
        signal: controller.signal,
        headers: {
          accept: "text/*,*/*;q=0.8",
          "user-agent":
            "Mozilla/5.0 (compatible; opencode-bot-agent/1.0; +https://github.com/opencode-ai/opencode)",
        },
      },
      ssrfPolicy,
      fetchFn,
    );
    if (!response.ok) {
      throw new Error(`attachment fetch failed: http ${response.status}`);
    }

    const contentLength = response.headers.get("content-length");
    if (contentLength) {
      const length = Number(contentLength);
      if (Number.isFinite(length) && length > maxBytes) {
        throw new Error(`attachment too large: ${length} > ${maxBytes}`);
      }
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.byteLength > maxBytes) {
      throw new Error(
        `attachment too large: ${buffer.byteLength} > ${maxBytes}`,
      );
    }

    const text = buffer.toString("utf8");
    if (!text.trim()) {
      throw new Error("attachment is empty");
    }

    return { filename, content: text };
  } catch (err) {
    logger?.debug?.({ err, url: attachment.url }, "Failed to fetch attachment");
    throw err;
  } finally {
    clearTimeout(timeout);
  }
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

function normalizeContentType(value: string): string {
  return value.split(";")[0]?.trim().toLowerCase() ?? "";
}

function extensionFromFilename(filename: string): string | null {
  const basename = filename.split("/").pop()?.trim() ?? "";
  const idx = basename.lastIndexOf(".");
  if (idx <= 0 || idx === basename.length - 1) {
    return null;
  }
  return basename.slice(idx).toLowerCase();
}
