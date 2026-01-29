import { describe, expect, test } from "bun:test";

import { formatDiceResult, parseDiceSpec, rollDice } from "../dice";

describe("parseDiceSpec", () => {
  test("parses valid dice specs", () => {
    expect(parseDiceSpec("1d1")).toEqual({ count: 1, sides: 1 });
    expect(parseDiceSpec("2d100")).toEqual({ count: 2, sides: 100 });
    expect(parseDiceSpec(" 10 d 20 ")).toEqual({ count: 10, sides: 20 });
    expect(parseDiceSpec("3D6")).toEqual({ count: 3, sides: 6 });
  });

  test("rejects out-of-range dice specs", () => {
    expect(parseDiceSpec("0d6")).toBeNull();
    expect(parseDiceSpec("11d6")).toBeNull();
    expect(parseDiceSpec("2d0")).toBeNull();
    expect(parseDiceSpec("2d101")).toBeNull();
  });

  test("rejects non-dice strings", () => {
    expect(parseDiceSpec("d100")).toBeNull();
    expect(parseDiceSpec("2d")).toBeNull();
    expect(parseDiceSpec("2d100+1")).toBeNull();
    expect(parseDiceSpec("roll 2d100")).toBeNull();
    expect(parseDiceSpec("2d100 please")).toBeNull();
  });
});

describe("rollDice", () => {
  test("returns rolls in range and sums correctly", () => {
    const spec = { count: 10, sides: 100 };
    for (let i = 0; i < 50; i += 1) {
      const result = rollDice(spec);
      expect(result.rolls).toHaveLength(10);
      for (const value of result.rolls) {
        expect(value).toBeGreaterThanOrEqual(1);
        expect(value).toBeLessThanOrEqual(100);
      }
      const sum = result.rolls.reduce((acc, v) => acc + v, 0);
      expect(result.total).toBe(sum);
    }
  });
});

describe("formatDiceResult", () => {
  test("formats single die result", () => {
    expect(
      formatDiceResult({ count: 1, sides: 20 }, { rolls: [7], total: 7 }),
    ).toBe("1d20 = 7");
  });

  test("formats multi-dice result", () => {
    expect(
      formatDiceResult({ count: 2, sides: 6 }, { rolls: [1, 6], total: 7 }),
    ).toBe("2d6 = 1 + 6 = 7");
  });
});
