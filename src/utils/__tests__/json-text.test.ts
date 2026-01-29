import { describe, expect, test } from "bun:test";

import { extractTextFromJsonDocument } from "../json-text";

describe("extractTextFromJsonDocument", () => {
  test("returns null for non-json", () => {
    expect(extractTextFromJsonDocument("hello")).toBeNull();
  });

  test("extracts entries payload content", () => {
    const input = JSON.stringify({
      entries: {
        0: { comment: "两仪式", content: "<两仪式>...content...</两仪式>" },
        1: {
          comment: "卫宫士郎",
          content: "<卫宫士郎>...content...</卫宫士郎>",
        },
      },
    });
    const extracted = extractTextFromJsonDocument(input);
    expect(extracted?.kind).toBe("entries");
    expect(extracted?.extracted).toContain("## 两仪式");
    expect(extracted?.extracted).toContain("<两仪式>...content...</两仪式>");
    expect(extracted?.extracted).toContain("## 卫宫士郎");
  });

  test("extracts generic text keys", () => {
    const input = JSON.stringify({
      meta: { id: 1 },
      prompt: "A long enough prompt to keep",
      nested: { description: "A long enough description to keep" },
      ignored: { foo: "short" },
    });
    const extracted = extractTextFromJsonDocument(input);
    expect(extracted?.kind).toBe("generic");
    expect(extracted?.extracted).toContain("A long enough prompt to keep");
    expect(extracted?.extracted).toContain("A long enough description to keep");
    expect(extracted?.extracted).not.toContain("short");
  });
});
