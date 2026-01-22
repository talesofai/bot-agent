import { z } from "zod";

export function parseEnvBoolean(value: unknown): boolean | undefined | unknown {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    return value !== 0;
  }
  if (typeof value !== "string") {
    return value;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === "") {
    return undefined;
  }
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }
  return value;
}

export function zEnvBoolean(defaultValue: boolean) {
  return z.preprocess(parseEnvBoolean, z.boolean()).default(defaultValue);
}
