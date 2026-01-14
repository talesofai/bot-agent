import { appendFile, readFile } from "node:fs/promises";
import type { Logger } from "pino";
import type { HistoryEntry } from "../types/session";

export interface HistoryReadOptions {
  maxBytes?: number;
  maxEntries?: number;
}

export class HistoryStore {
  private logger: Logger;

  constructor(logger: Logger) {
    this.logger = logger.child({ component: "history-store" });
  }

  async readHistory(
    historyPath: string,
    options: HistoryReadOptions = {},
  ): Promise<HistoryEntry[]> {
    try {
      const content = await readFile(historyPath, "utf-8");
      if (!content) {
        return [];
      }

      const maxEntries = options.maxEntries ?? 0;
      let linesToParse = content;
      if (maxEntries > 0) {
        const offset = this.findStartOffset(content, maxEntries);
        if (offset > 0) {
          linesToParse = content.slice(offset);
        }
      }

      return linesToParse
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
          try {
            return JSON.parse(line) as HistoryEntry;
          } catch {
            return null;
          }
        })
        .filter((entry): entry is HistoryEntry => entry !== null);
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

  private findStartOffset(content: string, maxLines: number): number {
    let count = 0;
    let index = content.length - 1;
    if (content[index] === "\n") {
      index -= 1;
    }
    while (index >= 0) {
      if (content[index] === "\n") {
        count += 1;
        if (count >= maxLines) {
          return index + 1;
        }
      }
      index -= 1;
    }
    return 0;
  }
}
