import { describe, expect, test } from "bun:test";

import { parseOpencodeOutput } from "../output";

describe("parseOpencodeOutput", () => {
  test("parses history entries from messages array", () => {
    const createdAt = "2026-01-13T00:00:00.000Z";
    const raw = JSON.stringify([
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
    ]);
    const result = parseOpencodeOutput(raw, createdAt);
    expect(result?.historyEntries).toEqual([
      { role: "user", content: "hi", createdAt },
      { role: "assistant", content: "hello", createdAt },
    ]);
    expect(result?.output).toBe("hello");
  });

  test("prefers explicit output field", () => {
    const createdAt = "2026-01-13T00:00:00.000Z";
    const raw = JSON.stringify({ output: "done" });
    const result = parseOpencodeOutput(raw, createdAt);
    expect(result).toEqual({ output: "done" });
  });

  test("parses last JSON line when logs are mixed", () => {
    const createdAt = "2026-01-13T00:00:00.000Z";
    const raw = ["log line", '{"content":"ok","role":"assistant"}'].join("\n");
    const result = parseOpencodeOutput(raw, createdAt);
    expect(result?.output).toBe("ok");
    expect(result?.historyEntries).toEqual([
      { role: "assistant", content: "ok", createdAt },
    ]);
  });
});
