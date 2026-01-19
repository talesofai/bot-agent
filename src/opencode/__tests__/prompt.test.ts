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
    expect(system).toBe("You are a helpful assistant.");
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
