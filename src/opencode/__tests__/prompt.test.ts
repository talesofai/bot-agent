import { describe, expect, test } from "bun:test";

import { buildOpencodePrompt } from "../prompt";
import { buildSystemPrompt } from "../default-system-prompt";

describe("buildSystemPrompt", () => {
  test("returns trimmed agent prompt", () => {
    const system = buildSystemPrompt("You are helpful.");
    expect(system).toBe("You are helpful.");
  });

  test("falls back to default prompt when empty", () => {
    const system = buildSystemPrompt("   ");
    expect(system).toBe(
      [
        "你是一个可靠的中文助理。",
        "直接回答问题；不确定就说不知道，不要编造。",
        "需要给出链接/图片时，先在当前环境验证可访问性；验证失败就不要输出该链接。",
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
