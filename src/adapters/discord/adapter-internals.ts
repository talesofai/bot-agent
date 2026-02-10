import path from "node:path";
import { mkdir, rename, writeFile } from "node:fs/promises";
import type { UserLanguage } from "../../user/state-store";

export function pickByLanguage(
  language: UserLanguage | null | undefined,
  zh: string,
  en: string,
): string {
  return language === "en" ? en : zh;
}

export const DEFAULT_DISCORD_IMAGE_ATTACHMENT_MAX_BYTES = 12 * 1024 * 1024;
export const DEFAULT_DISCORD_IMAGE_ATTACHMENT_TIMEOUT_MS = 10_000;

export class LocalizedError extends Error {
  readonly zh: string;
  readonly en: string;

  constructor(input: { zh: string; en: string }) {
    super(input.zh);
    this.zh = input.zh;
    this.en = input.en;
    this.name = "LocalizedError";
  }
}

export function resolveUserMessageFromError(
  language: UserLanguage | null | undefined,
  err: unknown,
  fallback: { zh: string; en: string },
): string {
  if (err instanceof LocalizedError) {
    return language === "en" ? err.en : err.zh;
  }
  return language === "en" ? fallback.en : fallback.zh;
}

export async function atomicWrite(
  filePath: string,
  content: string,
): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tmpPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`,
  );
  await writeFile(
    tmpPath,
    content.endsWith("\n") ? content : `${content}\n`,
    "utf8",
  );
  await rename(tmpPath, filePath);
}
