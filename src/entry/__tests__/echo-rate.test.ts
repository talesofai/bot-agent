import { describe, expect, test } from "bun:test";

import { resolveEchoRate } from "../echo-rate";

describe("resolveEchoRate", () => {
  test("prefers bot override, then group, then global", () => {
    expect(resolveEchoRate(12, 34, 56)).toBe(12);
    expect(resolveEchoRate(null, 34, 56)).toBe(34);
    expect(resolveEchoRate(undefined, null, 56)).toBe(56);
  });

  test("treats zero as a valid override", () => {
    expect(resolveEchoRate(0, 34, 56)).toBe(0);
    expect(resolveEchoRate(null, 0, 56)).toBe(0);
  });
});
