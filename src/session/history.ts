import { open, readFile, appendFile, stat } from "node:fs/promises";
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
      const content = await this.readTail(historyPath, maxBytes);
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

  private async readTail(
    historyPath: string,
    maxBytes: number,
  ): Promise<string> {
    const fileStat = await stat(historyPath);
    if (fileStat.size === 0) {
      return "";
    }

    const length = Math.min(fileStat.size, maxBytes);
    const start = Math.max(0, fileStat.size - length);
    const handle = await open(historyPath, "r");
    try {
      let startsAtLine = start === 0;
      if (!startsAtLine) {
        const prefix = Buffer.alloc(1);
        await handle.read(prefix, 0, 1, start - 1);
        startsAtLine = prefix.toString("utf-8") === "\n";
      }
      const buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, start);
      let raw = buffer.toString("utf-8");
      if (!startsAtLine) {
        const newlineIndex = raw.indexOf("\n");
        raw = newlineIndex === -1 ? "" : raw.slice(newlineIndex + 1);
      }
      return raw;
    } finally {
      await handle.close();
    }
  }
}
