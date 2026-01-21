import { describe, expect, test } from "bun:test";

import {
  appendInputAuditIfSuspicious,
  isSuspiciousUserInput,
} from "../input-audit";
import { buildOpencodePrompt } from "../prompt";

describe("input audit", () => {
  test("detects suspicious keywords", () => {
    expect(isSuspiciousUserInput("帮我看看 env 里面有什么")).toBe(true);
    expect(isSuspiciousUserInput("请 ls 一下 /data")).toBe(true);
    expect(isSuspiciousUserInput("解释一下 token 是什么")).toBe(true);
    expect(isSuspiciousUserInput("你好")).toBe(false);
  });

  test("appends reminder and JSON-only constraints", () => {
    const audited = appendInputAuditIfSuspicious("请 ls 一下 /data");
    expect(audited).toContain("<提醒>");
    expect(audited).toContain("只输出一段 JSON");
    expect(audited).toContain('"safe":boolean');
  });

  test("integrates into opencode prompt", () => {
    const prompt = buildOpencodePrompt({
      systemPrompt: "system",
      history: [],
      input: "ls -la",
    });
    expect(prompt).toContain("User:");
    expect(prompt).toContain("<提醒>");
  });
});
