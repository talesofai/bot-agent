import { describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";

import { SessionRepository } from "../repository";

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "session-repo-test-"));
}

describe("SessionRepository", () => {
  test("resolveActiveSessionId skips inactive sessions referenced by index", async () => {
    const tempDir = makeTempDir();
    const logger = pino({ level: "silent" });
    const repository = new SessionRepository({ dataDir: tempDir, logger });

    const botId = "bot-1";
    const groupId = "group-1";
    const userId = "user-1";

    const now = new Date().toISOString();
    await repository.createSession({
      sessionId: "session-1",
      groupId,
      botId,
      ownerId: userId,
      key: 0,
      status: "idle",
      active: false,
      archivedAt: now,
      createdAt: now,
      updatedAt: now,
    });

    const userPath = join(tempDir, "sessions", botId, groupId, userId);
    mkdirSync(userPath, { recursive: true });
    const indexPath = join(userPath, "index.json");
    writeFileSync(
      indexPath,
      `${JSON.stringify({ version: 1, active: { "0": "session-1" } }, null, 2)}\n`,
      "utf-8",
    );

    const resolved = await repository.resolveActiveSessionId(
      botId,
      groupId,
      userId,
      0,
    );
    expect(resolved).not.toBe("session-1");

    const updated = JSON.parse(readFileSync(indexPath, "utf-8")) as {
      active: Record<string, string>;
    };
    expect(updated.active["0"]).toBe(resolved);

    rmSync(tempDir, { recursive: true, force: true });
  });
});
