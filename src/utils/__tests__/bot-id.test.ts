import { describe, expect, test } from "bun:test";

import { parseBotIdAliases, resolveCanonicalBotId } from "../bot-id";

describe("parseBotIdAliases", () => {
  test("parses comma separated aliases", () => {
    const aliases = parseBotIdAliases("234:123,789:456");
    expect(aliases.get("234")).toBe("123");
    expect(aliases.get("789")).toBe("456");
  });

  test("throws on invalid entries", () => {
    expect(() => parseBotIdAliases("bad-entry")).toThrow();
  });
});

describe("resolveCanonicalBotId", () => {
  test("returns self when alias not set", () => {
    expect(resolveCanonicalBotId("plain-bot")).toBe("plain-bot");
  });
});
