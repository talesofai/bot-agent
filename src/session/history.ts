import { appendFile } from "node:fs/promises";
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
      const file = Bun.file(historyPath);
      const exists = await file.exists();
      if (!exists) {
        return [];
      }
      const size = file.size;
      if (size === 0) {
        return [];
      }

      const maxEntries = options.maxEntries ?? 0;
      const linesToParse =
        maxEntries > 0
          ? await this.readTailText(file, size, maxEntries, options.maxBytes)
          : await file.text();

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

  private async readTailText(
    file: ReturnType<typeof Bun.file>,
    size: number,
    maxEntries: number,
    maxBytes?: number,
  ): Promise<string> {
    const chunkSize = 16 * 1024;
    const minStart =
      typeof maxBytes === "number" && maxBytes > 0
        ? Math.max(0, size - maxBytes)
        : 0;
    let start = Math.max(minStart, size - chunkSize);
    let tail = await file.slice(start, size).text();

    while (start > minStart && this.countNewlines(tail) < maxEntries) {
      start = Math.max(minStart, start - chunkSize);
      tail = await file.slice(start, size).text();
    }

    const offset = this.findStartOffset(tail, maxEntries);
    return offset > 0 ? tail.slice(offset) : tail;
  }

  private countNewlines(content: string): number {
    let count = 0;
    for (let i = 0; i < content.length; i += 1) {
      if (content[i] === "\n") {
        count += 1;
      }
    }
    return count;
  }
}
