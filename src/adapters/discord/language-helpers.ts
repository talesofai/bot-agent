import type { UserLanguage } from "../../user/state-store";

export function resolveUserLanguageFromDiscordLocale(
  locale: string | null | undefined,
): UserLanguage | null {
  const normalized =
    typeof locale === "string" ? locale.trim().toLowerCase() : "";
  if (normalized.startsWith("zh")) {
    return "zh";
  }
  if (normalized.startsWith("en")) {
    return "en";
  }
  return null;
}

export function inferUserLanguageFromText(text: string): UserLanguage | null {
  const normalized = text.trim();
  if (!normalized) {
    return null;
  }
  if (/[\u4e00-\u9fff]/u.test(normalized)) {
    return "zh";
  }
  if (/^[/.]/.test(normalized)) {
    return null;
  }
  if (/[a-zA-Z]{2,}/.test(normalized)) {
    return "en";
  }
  return null;
}
