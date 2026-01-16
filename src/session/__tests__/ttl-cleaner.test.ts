import { describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";

import { SessionTtlCleaner } from "../ttl-cleaner";

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "session-ttl-cleaner-test-"));
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe("SessionTtlCleaner", () => {
  test("does not treat directory mtime as lastActive", async () => {
    const tempDir = makeTempDir();
    const logger = pino({ level: "silent" });
    const cleaner = new SessionTtlCleaner({
      dataDir: tempDir,
      logger,
      ttlMs: 1000,
    });

    const botId = "qq-123";
    const userId = "user-1";
    const groupId = "group-1";
    const sessionId = "user-1-0";
    const sessionPath = join(
      tempDir,
      "sessions",
      botId,
      groupId,
      userId,
      sessionId,
    );
    mkdirSync(sessionPath, { recursive: true });

    const now = Date.now();
    const metaPath = join(sessionPath, "meta.json");
    const meta = {
      sessionId,
      groupId,
      botId,
      ownerId: userId,
      key: 0,
      status: "idle",
      createdAt: new Date(now - 10_000).toISOString(),
      updatedAt: new Date(now - 100).toISOString(),
    };
    writeFileSync(metaPath, `${JSON.stringify(meta)}\n`, "utf-8");

    const old = new Date(now - 10_000);
    utimesSync(sessionPath, old, old);
    utimesSync(metaPath, old, old);

    const removed = await cleaner.cleanup();
    expect(removed).toBe(0);
    expect(existsSync(sessionPath)).toBe(true);

    rmSync(tempDir, { recursive: true, force: true });
  });

  test("removes sessions stale by meta.updatedAt", async () => {
    const tempDir = makeTempDir();
    const logger = pino({ level: "silent" });
    const cleaner = new SessionTtlCleaner({
      dataDir: tempDir,
      logger,
      ttlMs: 1000,
    });

    const botId = "qq-123";
    const userId = "user-1";
    const groupId = "group-1";
    const sessionId = "user-1-0";
    const sessionPath = join(
      tempDir,
      "sessions",
      botId,
      groupId,
      userId,
      sessionId,
    );
    mkdirSync(sessionPath, { recursive: true });

    const now = Date.now();
    const metaPath = join(sessionPath, "meta.json");
    const meta = {
      sessionId,
      groupId,
      botId,
      ownerId: userId,
      key: 0,
      status: "idle",
      createdAt: new Date(now - 10_000).toISOString(),
      updatedAt: new Date(now - 10_000).toISOString(),
    };
    writeFileSync(metaPath, `${JSON.stringify(meta)}\n`, "utf-8");

    const removed = await cleaner.cleanup();
    expect(removed).toBe(1);
    expect(existsSync(sessionPath)).toBe(false);

    rmSync(tempDir, { recursive: true, force: true });
  });
});
