import type { UserLanguage } from "../user/state-store";

import { buildInputAuditReminder } from "../texts";

const SUSPICIOUS_INPUT_PATTERNS: RegExp[] = [
  /\b(process\.env|printenv|export|unset)\b/i,
  /\b(env|dotenv)\b/i,
  /\b(ls|cat|head|tail|grep|rg|find|pwd|cd)\b/i,
  /\b(token|x-token|api[_-]?key|apikey|secret|password|authorization|bearer)\b/i,
  /\/etc\/|\/proc\/|\/root\/|\/home\/|\.env\b/i,
  /环境变量|文件系统|读取文件|查看文件|列出文件|目录|路径|执行命令/i,
];

export function isSuspiciousUserInput(input: string): boolean {
  const text = input.trim();
  if (!text) {
    return false;
  }
  return SUSPICIOUS_INPUT_PATTERNS.some((pattern) => pattern.test(text));
}

export function appendInputAuditIfSuspicious(
  input: string,
  language?: UserLanguage | null,
): string {
  if (!isSuspiciousUserInput(input)) {
    return input;
  }
  if (input.includes("<提醒>") && input.includes("</提醒>")) {
    return input;
  }
  return `${input}\n\n${buildInputAuditReminder(language)}`;
}
