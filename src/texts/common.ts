import type { UserLanguage } from "../user/state-store";

export function resolveUserLanguage(
  language: UserLanguage | null | undefined,
): UserLanguage {
  return language === "en" ? "en" : "zh";
}

export function pick(
  language: UserLanguage | null | undefined,
  zh: string,
  en: string,
) {
  return resolveUserLanguage(language) === "en" ? en : zh;
}
