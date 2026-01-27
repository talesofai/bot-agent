import path from "node:path";
import type { AppConfig } from "../config";

export function resolveDataRoot(config: AppConfig): string {
  const explicit = config.DATA_DIR?.trim();
  if (explicit) {
    return explicit;
  }
  return path.dirname(config.GROUPS_DATA_DIR);
}
