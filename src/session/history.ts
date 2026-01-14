import { Database } from "bun:sqlite";
import type { Logger } from "pino";
import type { HistoryEntry } from "../types/session";

export interface HistoryReadOptions {
  maxBytes?: number;
  maxEntries?: number;
}

interface HistoryRow {
  role: HistoryEntry["role"];
  content: string;
  createdAt: string;
  extra: string | null;
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
    const db = this.open(historyPath);
    try {
      const maxEntries = options.maxEntries ?? 0;
      const rows =
        maxEntries > 0
          ? (db
              .prepare(
                "SELECT role, content, created_at AS createdAt, extra FROM history ORDER BY id DESC LIMIT ?",
              )
              .all(maxEntries) as HistoryRow[])
          : (db
              .prepare(
                "SELECT role, content, created_at AS createdAt, extra FROM history ORDER BY id ASC",
              )
              .all() as HistoryRow[]);

      const ordered = maxEntries > 0 ? rows.reverse() : rows;
      const entries = ordered.map((row) => parseHistoryRow(row));
      return applyMaxBytes(entries, options.maxBytes);
    } catch (err) {
      this.logger.warn({ err, historyPath }, "Failed to read history");
      return [];
    } finally {
      db.close();
    }
  }

  async appendHistory(historyPath: string, entry: HistoryEntry): Promise<void> {
    const db = this.open(historyPath);
    try {
      const { role, content, createdAt, ...extra } = entry;
      const extraJson =
        Object.keys(extra).length > 0 ? JSON.stringify(extra) : null;
      db.prepare(
        "INSERT INTO history (role, content, created_at, extra) VALUES (?, ?, ?, ?)",
      ).run(role, content, createdAt, extraJson);
    } catch (err) {
      this.logger.warn({ err, historyPath }, "Failed to append history");
    } finally {
      db.close();
    }
  }

  private open(historyPath: string): Database {
    const db = new Database(historyPath);
    db.exec(
      "CREATE TABLE IF NOT EXISTS history (id INTEGER PRIMARY KEY AUTOINCREMENT, role TEXT NOT NULL, content TEXT NOT NULL, created_at TEXT NOT NULL, extra TEXT)",
    );
    return db;
  }
}

function parseHistoryRow(row: HistoryRow): HistoryEntry {
  const base: HistoryEntry = {
    role: row.role,
    content: row.content,
    createdAt: row.createdAt,
  };
  if (!row.extra) {
    return base;
  }
  try {
    const extra = JSON.parse(row.extra) as Record<string, unknown>;
    return { ...base, ...extra };
  } catch {
    return base;
  }
}

function applyMaxBytes(
  entries: HistoryEntry[],
  maxBytes?: number,
): HistoryEntry[] {
  if (!maxBytes || maxBytes <= 0) {
    return entries;
  }
  let total = 0;
  let startIndex = entries.length;
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    total += Buffer.byteLength(JSON.stringify(entries[i]), "utf-8");
    if (total > maxBytes) {
      break;
    }
    startIndex = i;
  }
  return entries.slice(startIndex);
}
