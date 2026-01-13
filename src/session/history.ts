import { constants } from "node:fs";
import { access, appendFile, open } from "node:fs/promises";
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
    try {
      if (!(await this.exists(historyPath))) {
        return [];
      }
      const content = await this.readTail(historyPath, options);
      if (!content.trim()) {
        return [];
      }
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
    options: HistoryReadOptions,
  ): Promise<string> {
    const maxEntries = options.maxEntries;
    if (typeof maxEntries === "number" && maxEntries > 0) {
      const maxBytes = options.maxBytes ?? this.maxBytes;
      return this.readTailByLines(historyPath, maxEntries, maxBytes);
    }
    const maxBytes = options.maxBytes ?? this.maxBytes;
    return this.readTailByBytes(historyPath, maxBytes);
  }

  private async exists(historyPath: string): Promise<boolean> {
    try {
      await access(historyPath, constants.F_OK);
      return true;
    } catch {
      return false;
    }
  }

  private async readTailByBytes(
    historyPath: string,
    maxBytes: number,
  ): Promise<string> {
    const file = await open(historyPath, "r");
    try {
      const stat = await file.stat();
      if (stat.size === 0) {
        return "";
      }
      const readSize = Math.min(maxBytes, stat.size);
      const buffer = Buffer.allocUnsafe(readSize);
      const { bytesRead } = await file.read(
        buffer,
        0,
        readSize,
        stat.size - readSize,
      );
      return buffer.subarray(0, bytesRead).toString("utf-8");
    } finally {
      await file.close();
    }
  }

  private async readTailByLines(
    historyPath: string,
    maxEntries: number,
    maxBytes: number,
  ): Promise<string> {
    const file = await open(historyPath, "r");
    try {
      const stat = await file.stat();
      if (stat.size === 0) {
        return "";
      }
      const chunks: Buffer[] = [];
      const chunkSize = 64 * 1024;
      let position = stat.size;
      let linesFound = 0;
      let totalBytes = 0;

      while (position > 0 && linesFound <= maxEntries) {
        const readSize = Math.min(chunkSize, position);
        position -= readSize;
        const buffer = Buffer.allocUnsafe(readSize);
        const { bytesRead } = await file.read(buffer, 0, readSize, position);
        const slice = buffer.subarray(0, bytesRead);
        const newLines = countNewlines(slice);
        const totalLines = linesFound + newLines;

        if (totalLines > maxEntries) {
          const keepLines = maxEntries - linesFound;
          const trimmed =
            keepLines > 0 ? trimToLastLines(slice, keepLines) : null;
          if (trimmed && trimmed.length > 0) {
            chunks.unshift(trimmed);
            totalBytes += trimmed.length;
          }
          linesFound = maxEntries;
          break;
        }

        chunks.unshift(slice);
        totalBytes += bytesRead;
        linesFound = totalLines;
        if (totalBytes >= maxBytes) {
          break;
        }
      }

      return Buffer.concat(chunks).toString("utf-8");
    } finally {
      await file.close();
    }
  }
}

function countNewlines(buffer: Buffer): number {
  let count = 0;
  let offset = buffer.length;
  while ((offset = buffer.lastIndexOf(10, offset - 1)) !== -1) {
    count += 1;
  }
  return count;
}

function trimToLastLines(buffer: Buffer, keepLines: number): Buffer {
  let position = buffer.length - 1;
  let newlineIndex = -1;
  for (let i = 0; i < keepLines; i += 1) {
    newlineIndex = buffer.lastIndexOf(10, position);
    if (newlineIndex === -1) {
      return buffer;
    }
    position = newlineIndex - 1;
  }
  return buffer.subarray(newlineIndex + 1);
}
