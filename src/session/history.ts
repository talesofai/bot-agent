import type { Logger } from "pino";
import type { HistoryEntry } from "../types/session";
import type { JSONValue, Sql } from "postgres";
import { createPostgresClient } from "../db/postgres";

export interface HistoryReadOptions {
  maxBytes?: number;
  maxEntries?: number;
}

export interface HistoryKey {
  botAccountId: string;
  userId: string;
}

export interface HistoryStore {
  readHistory(
    key: HistoryKey,
    options?: HistoryReadOptions,
  ): Promise<HistoryEntry[]>;
  appendHistory(key: HistoryKey, entry: HistoryEntry): Promise<void>;
  close(): Promise<void>;
}

export class InMemoryHistoryStore implements HistoryStore {
  private entries = new Map<string, HistoryEntry[]>();

  async readHistory(
    key: HistoryKey,
    options: HistoryReadOptions = {},
  ): Promise<HistoryEntry[]> {
    const stored = this.entries.get(composeKey(key)) ?? [];
    const maxEntries = options.maxEntries ?? 0;
    const selected =
      maxEntries > 0
        ? stored.slice(Math.max(0, stored.length - maxEntries))
        : stored;
    return applyMaxBytes([...selected], options.maxBytes);
  }

  async appendHistory(key: HistoryKey, entry: HistoryEntry): Promise<void> {
    const composed = composeKey(key);
    const stored = this.entries.get(composed) ?? [];
    stored.push(entry);
    this.entries.set(composed, stored);
  }

  async close(): Promise<void> {}
}

export interface PostgresHistoryStoreOptions {
  databaseUrl: string;
  maxConnections?: number;
  ensureSchema?: boolean;
}

interface HistoryRow {
  role: HistoryEntry["role"];
  content: string;
  createdAt: string;
  groupId: string;
  meta: unknown;
}

export class PostgresHistoryStore implements HistoryStore {
  private logger: Logger;
  private sql: Sql;
  private initPromise: Promise<void> | null = null;
  private ensureSchema: boolean;

  constructor(logger: Logger, options: PostgresHistoryStoreOptions) {
    this.logger = logger.child({ component: "history-store" });
    this.sql = createPostgresClient({
      databaseUrl: options.databaseUrl,
      maxConnections: options.maxConnections,
    });
    this.ensureSchema = options.ensureSchema ?? true;
  }

  async readHistory(
    key: HistoryKey,
    options: HistoryReadOptions = {},
  ): Promise<HistoryEntry[]> {
    await this.init();
    const maxEntries = options.maxEntries ?? 0;
    const limit = maxEntries > 0 ? maxEntries : 200;
    try {
      const rows = await this.sql<HistoryRow[]>`
        SELECT role,
               content,
               created_at AS "createdAt",
               group_id AS "groupId",
               meta
         FROM history_entries
         WHERE bot_account_id = ${key.botAccountId}
           AND user_id = ${key.userId}
         ORDER BY created_at DESC, id DESC
         LIMIT ${limit}
      `;
      const ordered = rows.reverse().map((row) => parseHistoryRow(row));
      return applyMaxBytes(ordered, options.maxBytes);
    } catch (err) {
      this.logger.warn({ err, key }, "Failed to read history");
      return [];
    }
  }

  async appendHistory(key: HistoryKey, entry: HistoryEntry): Promise<void> {
    await this.init();
    const { role, content, createdAt, groupId, ...meta } = entry;
    const resolvedGroupId = typeof groupId === "string" ? groupId : "0";
    const metaPayload =
      Object.keys(meta).length > 0 ? normalizeHistoryMeta(meta) : null;
    const metaParam = metaPayload ? this.sql.json(metaPayload) : null;
    try {
      await this.sql`
        INSERT INTO history_entries
          (bot_account_id, user_id, group_id, role, content, created_at, meta)
        VALUES
          (${key.botAccountId}, ${key.userId}, ${resolvedGroupId}, ${role}, ${content}, ${createdAt}, ${metaParam})
      `;
    } catch (err) {
      this.logger.warn({ err, key }, "Failed to append history");
    }
  }

  async close(): Promise<void> {
    await this.sql.end();
  }

  private async init(): Promise<void> {
    if (this.initPromise) {
      return this.initPromise;
    }
    this.initPromise = this.ensureSchema
      ? this.ensureSchemaReady()
      : Promise.resolve();
    return this.initPromise;
  }

  private async ensureSchemaReady(): Promise<void> {
    await this.sql`
      CREATE TABLE IF NOT EXISTS history_entries (
        id BIGSERIAL PRIMARY KEY,
        bot_account_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        group_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at TEXT NOT NULL,
        meta JSONB
      )
    `;
    await this.sql`
      CREATE INDEX IF NOT EXISTS history_entries_lookup_idx
        ON history_entries (bot_account_id, user_id, id)
    `;
  }
}

function composeKey(key: HistoryKey): string {
  return `${key.botAccountId}:${key.userId}`;
}

function parseHistoryRow(row: HistoryRow): HistoryEntry {
  const base: HistoryEntry = {
    role: row.role,
    content: row.content,
    createdAt: row.createdAt,
    groupId: row.groupId,
  };
  if (!row.meta || !isRecord(row.meta)) {
    return base;
  }
  return { ...base, ...row.meta };
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeHistoryMeta(meta: Record<string, unknown>): JSONValue | null {
  const normalized = toJsonValue(meta, new WeakSet());
  if (normalized === undefined || normalized === null) {
    return null;
  }
  if (typeof normalized !== "object" || Array.isArray(normalized)) {
    return null;
  }
  if (Object.keys(normalized).length === 0) {
    return null;
  }
  return normalized;
}

function toJsonValue(
  value: unknown,
  seen: WeakSet<object>,
): JSONValue | undefined {
  if (value === null) {
    return null;
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value !== "object") {
    return undefined;
  }

  if (Array.isArray(value)) {
    const items: JSONValue[] = [];
    for (const entry of value) {
      const normalized = toJsonValue(entry, seen);
      items.push(normalized === undefined ? null : normalized);
    }
    return items;
  }

  if (seen.has(value)) {
    return undefined;
  }
  seen.add(value);

  const candidate = value as { toJSON?: unknown };
  if (typeof candidate.toJSON === "function") {
    try {
      return toJsonValue(candidate.toJSON(), seen);
    } catch {
      return undefined;
    }
  }

  const result: Record<string, JSONValue> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    const normalized = toJsonValue(entry, seen);
    if (normalized === undefined) {
      continue;
    }
    result[key] = normalized;
  }
  return result;
}
