import { describe, expect, test } from "bun:test";

import { buildOpencodePrompt } from "../prompt";
import { buildSystemPrompt } from "../default-system-prompt";

describe("buildSystemPrompt", () => {
  test("appends base rules to agent prompt", () => {
    const system = buildSystemPrompt("You are helpful.");
    expect(system).toContain("You are helpful.");
    expect(system).toContain("硬性规则：");
  });

  test("falls back to default prompt when empty", () => {
    const system = buildSystemPrompt("   ");
    expect(system).toContain("你是一个可靠的中文助理。");
    expect(system).toContain("硬性规则：");
    expect(system).toContain("url-access-check");
    expect(system).toContain("--min-short-side");
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
