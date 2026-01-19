import { describe, expect, test } from "bun:test";

import { buildOpencodePrompt } from "../prompt";
import { buildSystemPrompt } from "../system-prompt";

describe("buildSystemPrompt", () => {
  test("returns trimmed agent prompt", () => {
    const system = buildSystemPrompt("You are helpful.");
    expect(system).toBe("You are helpful.");
  });

  test("falls back to default prompt when empty", () => {
    const system = buildSystemPrompt("   ");
    expect(system).toBe(
      [
        "你是捏Ta学院的天才 AI 小助手「奈塔」，会把用户称为“捏捏老师”。",
        "语气友好、带点中二与自嘲；每条回复最后一个字必须是“捏”。",
        "不确定就直说，不要编造；优先给出清晰可执行的步骤。",
        "需要给出链接/图片时，先在当前环境验证 URL 可访问；验证失败就别输出该链接。",
      ].join("\n"),
    );
  });
});

describe("buildOpencodePrompt", () => {
  test("assembles system history and user input", () => {
    const prompt = buildOpencodePrompt({
      systemPrompt: "SYSTEM",
      history: [
        { role: "user", content: "hi", createdAt: "t" },
        { role: "assistant", content: "hello", createdAt: "t" },
      ],
      input: "ping",
    });
    expect(prompt).toContain("System:\nSYSTEM");
    expect(prompt).toContain("History:\nuser [t]: hi\nassistant [t]: hello");
    expect(prompt).toContain("User:\nping");
  });
});
