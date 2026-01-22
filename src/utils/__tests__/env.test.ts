import { describe, expect, test } from "bun:test";

import { parseEnvBoolean, zEnvBoolean } from "../env";

describe("parseEnvBoolean", () => {
  test("treats undefined/empty strings as unset", () => {
    expect(parseEnvBoolean(undefined)).toBeUndefined();
    expect(parseEnvBoolean("")).toBeUndefined();
    expect(parseEnvBoolean("   ")).toBeUndefined();
  });

  test("parses common boolean strings", () => {
    expect(parseEnvBoolean("true")).toBe(true);
    expect(parseEnvBoolean("TRUE")).toBe(true);
    expect(parseEnvBoolean("1")).toBe(true);
    expect(parseEnvBoolean("yes")).toBe(true);
    expect(parseEnvBoolean("on")).toBe(true);

    expect(parseEnvBoolean("false")).toBe(false);
    expect(parseEnvBoolean("FALSE")).toBe(false);
    expect(parseEnvBoolean("0")).toBe(false);
    expect(parseEnvBoolean("no")).toBe(false);
    expect(parseEnvBoolean("off")).toBe(false);
  });

  test("parses boolean/number inputs", () => {
    expect(parseEnvBoolean(true)).toBe(true);
    expect(parseEnvBoolean(false)).toBe(false);
    expect(parseEnvBoolean(1)).toBe(true);
    expect(parseEnvBoolean(0)).toBe(false);
    expect(parseEnvBoolean(-1)).toBe(true);
  });

  test("passes through unknown values", () => {
    expect(parseEnvBoolean("maybe")).toBe("maybe");
    expect(parseEnvBoolean({})).toEqual({});
  });
});

describe("zEnvBoolean", () => {
  test("applies default on unset values", () => {
    expect(zEnvBoolean(false).parse(undefined)).toBe(false);
    expect(zEnvBoolean(true).parse(undefined)).toBe(true);
  });

  test("rejects unknown strings", () => {
    expect(() => zEnvBoolean(false).parse("maybe")).toThrow();
  });
});
