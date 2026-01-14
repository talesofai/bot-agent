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

  test("accepts explicit empty output", () => {
    const createdAt = "2026-01-13T00:00:00.000Z";
    const raw = JSON.stringify({ output: "" });
    const result = parseOpencodeOutput(raw, createdAt);
    expect(result).toEqual({ output: "" });
  });

  test("returns null for non-json output", () => {
    const createdAt = "2026-01-13T00:00:00.000Z";
    const raw = "log line";
    const result = parseOpencodeOutput(raw, createdAt);
    expect(result).toBeNull();
  });

  test("parses trailing json line after logs", () => {
    const createdAt = "2026-01-13T00:00:00.000Z";
    const raw = [
      "info: starting",
      "warn: something",
      JSON.stringify({ output: "ok" }),
    ].join("\n");
    const result = parseOpencodeOutput(raw, createdAt);
    expect(result).toEqual({ output: "ok" });
  });

  test("parses trailing multiline json after logs", () => {
    const createdAt = "2026-01-13T00:00:00.000Z";
    const raw = [
      "info: starting",
      "warn: something",
      "{",
      '  "output": "ok"',
      "}",
    ].join("\n");
    const result = parseOpencodeOutput(raw, createdAt);
    expect(result).toEqual({ output: "ok" });
  });

  test("parses leading json before logs", () => {
    const createdAt = "2026-01-13T00:00:00.000Z";
    const raw = [
      JSON.stringify({ output: "ok" }),
      "info: trailing",
      "warn: trailing",
    ].join("\n");
    const result = parseOpencodeOutput(raw, createdAt);
    expect(result).toEqual({ output: "ok" });
  });

  test("parses json between log lines", () => {
    const createdAt = "2026-01-13T00:00:00.000Z";
    const raw = [
      "info: leading",
      JSON.stringify({ output: "ok" }),
      "warn: trailing",
    ].join("\n");
    const result = parseOpencodeOutput(raw, createdAt);
    expect(result).toEqual({ output: "ok" });
  });
});
