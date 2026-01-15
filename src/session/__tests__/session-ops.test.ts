import { describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";

import { GroupFileRepository } from "../../store/repository";
import { InMemoryHistoryStore } from "../history";
import { SessionRepository } from "../repository";
import { createSession } from "../session-ops";

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "session-ops-test-"));
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe("createSession", () => {
  test("enforces maxSessions", async () => {
    const tempDir = makeTempDir();
    const logger = pino({ level: "silent" });
    const groupRepository = new GroupFileRepository({
      dataDir: tempDir,
      logger,
    });
    const sessionRepository = new SessionRepository({
      dataDir: tempDir,
      logger,
    });
    await expect(
      createSession({
        groupId: "group-1",
        userId: "user-1",
        key: 2,
        maxSessions: 2,
        groupRepository,
        sessionRepository,
      }),
    ).rejects.toThrow("Session key exceeds maxSessions");
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("allows existing session even if maxSessions lowered", async () => {
    const tempDir = makeTempDir();
    const logger = pino({ level: "silent" });
    const groupRepository = new GroupFileRepository({
      dataDir: tempDir,
      logger,
    });
    const sessionRepository = new SessionRepository({
      dataDir: tempDir,
      logger,
    });
    await createSession({
      groupId: "group-1",
      userId: "user-1",
      key: 1,
      maxSessions: 2,
      groupRepository,
      sessionRepository,
    });
    await expect(
      createSession({
        groupId: "group-1",
        userId: "user-1",
        key: 1,
        maxSessions: 1,
        groupRepository,
        sessionRepository,
      }),
    ).resolves.toBeTruthy();
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("rejects negative key", async () => {
    const tempDir = makeTempDir();
    const logger = pino({ level: "silent" });
    const groupRepository = new GroupFileRepository({
      dataDir: tempDir,
      logger,
    });
    const sessionRepository = new SessionRepository({
      dataDir: tempDir,
      logger,
    });
    await expect(
      createSession({
        groupId: "group-1",
        userId: "user-1",
        key: -1,
        maxSessions: 2,
        groupRepository,
        sessionRepository,
      }),
    ).rejects.toThrow("Session key must be a non-negative integer");
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("rejects unsafe groupId", async () => {
    const tempDir = makeTempDir();
    const logger = pino({ level: "silent" });
    const groupRepository = new GroupFileRepository({
      dataDir: tempDir,
      logger,
    });
    const sessionRepository = new SessionRepository({
      dataDir: tempDir,
      logger,
    });
    await expect(
      createSession({
        groupId: "../escape",
        userId: "user-1",
        key: 0,
        maxSessions: 1,
        groupRepository,
        sessionRepository,
      }),
    ).rejects.toThrow("groupId must be a safe path segment");
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("rejects unsafe userId", async () => {
    const tempDir = makeTempDir();
    const logger = pino({ level: "silent" });
    const groupRepository = new GroupFileRepository({
      dataDir: tempDir,
      logger,
    });
    const sessionRepository = new SessionRepository({
      dataDir: tempDir,
      logger,
    });
    await expect(
      createSession({
        groupId: "group-1",
        userId: "user/1",
        key: 0,
        maxSessions: 1,
        groupRepository,
        sessionRepository,
      }),
    ).rejects.toThrow("userId must be a safe path segment");
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("appendHistory writes entries", async () => {
    const tempDir = makeTempDir();
    const logger = pino({ level: "silent" });
    const groupRepository = new GroupFileRepository({
      dataDir: tempDir,
      logger,
    });
    const sessionRepository = new SessionRepository({
      dataDir: tempDir,
      logger,
    });
    const historyStore = new InMemoryHistoryStore();
    const session = await createSession({
      groupId: "group-1",
      userId: "user-1",
      key: 0,
      maxSessions: 1,
      groupRepository,
      sessionRepository,
    });
    await historyStore.appendHistory(
      { botAccountId: "test:bot-1", userId: session.meta.ownerId },
      {
        role: "user",
        content: "hello",
        createdAt: "t",
        groupId: session.meta.groupId,
      },
    );
    const history = await historyStore.readHistory({
      botAccountId: "test:bot-1",
      userId: session.meta.ownerId,
    });
    expect(history).toEqual([
      {
        role: "user",
        content: "hello",
        createdAt: "t",
        groupId: "group-1",
      },
    ]);
    rmSync(tempDir, { recursive: true, force: true });
  });
});
