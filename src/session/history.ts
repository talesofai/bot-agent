import { readFile, appendFile } from "node:fs/promises";
import type { Logger } from "pino";
import type { HistoryEntry } from "../types/session";

export interface HistoryReadOptions {
  maxBytes?: number;
  maxEntries?: number;
}

export class HistoryStore {
  private logger: Logger;
  private maxBytes: number;

  constructor(logger: Logger, maxBytes = 1024 * 1024) {
    this.logger = logger.child({ component: "history-store" });
    this.maxBytes = maxBytes;
  }

  async readHistory(
    historyPath: string,
    options: HistoryReadOptions = {},
  ): Promise<HistoryEntry[]> {
    const maxBytes = options.maxBytes ?? this.maxBytes;
    try {
      const content = await readFile(historyPath, "utf-8");
      let entries = content
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
          try {
            return JSON.parse(line) as HistoryEntry;
          } catch (err) {
            this.logger.warn({ err }, "Failed to parse history entry");
            return null;
          }
        })
        .filter((entry): entry is HistoryEntry => entry !== null);
      if (typeof maxBytes === "number" && maxBytes > 0 && entries.length > 0) {
        entries = this.trimEntriesByBytes(entries, maxBytes);
      }
      if (
        typeof options.maxEntries === "number" &&
        options.maxEntries > 0 &&
        entries.length > options.maxEntries
      ) {
        entries = entries.slice(-options.maxEntries);
      }
      return entries;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return [];
      }
      this.logger.warn({ err, historyPath }, "Failed to read history");
      return [];
    }
  }

  async appendHistory(historyPath: string, entry: HistoryEntry): Promise<void> {
    const line = `${JSON.stringify(entry)}\n`;
    await appendFile(historyPath, line, "utf-8");
  }

  private trimEntriesByBytes(
    entries: HistoryEntry[],
    maxBytes: number,
  ): HistoryEntry[] {
    let total = 0;
    const result: HistoryEntry[] = [];
    for (let i = entries.length - 1; i >= 0; i -= 1) {
      const line = JSON.stringify(entries[i]);
      const lineBytes = Buffer.byteLength(line, "utf-8") + 1;
      if (total + lineBytes > maxBytes) {
        break;
      }
      total += lineBytes;
      result.push(entries[i]);
    }
    return result.reverse();
  }
}
