import { describe, expect, test } from "bun:test";

import { buildOpencodePrompt } from "../prompt";
import { buildSystemPrompt } from "../system-prompt";

describe("buildSystemPrompt", () => {
  test("appends MCP usage method", () => {
    const system = buildSystemPrompt("You are helpful.");
    expect(system).toContain("You are helpful.");
    expect(system).toContain("# MCP Usage");
  });

  test("returns MCP usage when agent prompt empty", () => {
    const system = buildSystemPrompt("   ");
    expect(system).toContain("# MCP Usage");
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
