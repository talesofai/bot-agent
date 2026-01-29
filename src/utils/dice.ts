import { randomInt } from "node:crypto";

export type DiceSpec = {
  count: number;
  sides: number;
};

export function parseDiceSpec(input: string): DiceSpec | null {
  const trimmed = input.trim();
  if (!trimmed) {
    return null;
  }
  const match = trimmed.match(/^(\d{1,2})\s*[dD]\s*(\d{1,3})$/);
  if (!match) {
    return null;
  }

  const count = Number(match[1]);
  const sides = Number(match[2]);
  if (!Number.isInteger(count) || count < 1 || count > 10) {
    return null;
  }
  if (!Number.isInteger(sides) || sides < 1 || sides > 100) {
    return null;
  }

  return { count, sides };
}

export function rollDice(spec: DiceSpec): { rolls: number[]; total: number } {
  const rolls: number[] = [];
  let total = 0;
  for (let i = 0; i < spec.count; i += 1) {
    const value = randomInt(1, spec.sides + 1);
    rolls.push(value);
    total += value;
  }
  return { rolls, total };
}

export function formatDiceResult(
  spec: DiceSpec,
  result: {
    rolls: number[];
    total: number;
  },
): string {
  const notation = `${spec.count}d${spec.sides}`;
  if (result.rolls.length <= 1) {
    const value = result.rolls[0] ?? 0;
    return `${notation} = ${value}`;
  }
  return `${notation} = ${result.rolls.join(" + ")} = ${result.total}`;
}
