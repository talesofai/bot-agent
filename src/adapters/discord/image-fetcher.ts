import type { Logger } from "pino";
import type { Attachment } from "discord.js";
import { getConfig } from "../../config";
import { createSsrfPolicy, fetchWithSsrfProtection } from "../../utils/ssrf";
import {
  ALLOWED_DISCORD_IMAGE_EXTENSIONS,
  extensionFromFilename,
  safeParseHttpUrl,
} from "./url-helpers";

const DEFAULT_DISCORD_IMAGE_ATTACHMENT_MAX_BYTES = 12 * 1024 * 1024;
const DEFAULT_DISCORD_IMAGE_ATTACHMENT_TIMEOUT_MS = 10_000;

export async function fetchDiscordImageAttachment(
  attachment: Attachment,
  options?: {
    maxBytes?: number;
    timeoutMs?: number;
    logger?: Pick<Logger, "debug">;
  },
): Promise<{ filename: string; contentType: string; buffer: Buffer }> {
  const url = safeParseHttpUrl(attachment.url ?? "");
  if (!url) {
    throw new Error("attachment url is invalid");
  }

  const filename = (attachment.name ?? "").trim() || "image";
  const declaredContentType = (attachment.contentType ?? "")
    .split(";")[0]
    ?.trim()
    .toLowerCase();
  const extension = extensionFromFilename(filename);
  const hasImageType = Boolean(
    declaredContentType && declaredContentType.startsWith("image/"),
  );
  const hasImageExt = Boolean(
    extension && ALLOWED_DISCORD_IMAGE_EXTENSIONS.has(extension),
  );
  if (!hasImageType && !hasImageExt) {
    throw new Error(
      `unsupported attachment type: contentType=${attachment.contentType ?? "n/a"} filename=${filename}`,
    );
  }

  const maxBytes =
    options?.maxBytes ?? DEFAULT_DISCORD_IMAGE_ATTACHMENT_MAX_BYTES;
  const timeoutMs =
    options?.timeoutMs ?? DEFAULT_DISCORD_IMAGE_ATTACHMENT_TIMEOUT_MS;

  const declaredSize = attachment.size;
  if (
    typeof declaredSize === "number" &&
    Number.isFinite(declaredSize) &&
    declaredSize > maxBytes
  ) {
    throw new Error(`attachment too large: ${declaredSize} > ${maxBytes}`);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const ssrfPolicy = createSsrfPolicy(getConfig());
    const { response } = await fetchWithSsrfProtection(
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
      ssrfPolicy,
      (input, init) => fetch(input, init),
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

    const responseContentType =
      response.headers
        .get("content-type")
        ?.split(";")[0]
        ?.trim()
        .toLowerCase() ?? "";
    if (responseContentType && !responseContentType.startsWith("image/")) {
      throw new Error(
        `unsupported attachment type: contentType=${responseContentType} filename=${filename}`,
      );
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.byteLength > maxBytes) {
      throw new Error(
        `attachment too large: ${buffer.byteLength} > ${maxBytes}`,
      );
    }
    if (buffer.byteLength === 0) {
      throw new Error("attachment is empty");
    }

    const resolvedContentType =
      responseContentType || declaredContentType || "";
    return {
      filename,
      contentType: resolvedContentType,
      buffer,
    };
  } catch (err) {
    options?.logger?.debug?.(
      { err, url: attachment.url },
      "Failed to fetch discord image attachment",
    );
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}
