import { appendFile } from "node:fs/promises";
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
      return this.runTail(["-n", String(maxEntries), historyPath]);
    }
    const maxBytes = options.maxBytes ?? this.maxBytes;
    return this.runTail(["-c", String(maxBytes), historyPath]);
  }

  private async runTail(args: string[]): Promise<string> {
    const child = Bun.spawn(["tail", ...args], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    if (exitCode !== 0) {
      const detail = stderr.trim() || stdout.trim() || "unknown error";
      this.logger.warn({ detail }, "tail command failed");
      return "";
    }
    return stdout;
  }
}
