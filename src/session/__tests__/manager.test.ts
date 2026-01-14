import { describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SessionManager } from "../manager";

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "session-manager-test-"));
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe("SessionManager", () => {
  test("createSession enforces maxSessions", async () => {
    const tempDir = makeTempDir();
    const manager = new SessionManager({
      dataDir: tempDir,
    });
    await expect(
      manager.createSession("group-1", "user-1", { key: 2, maxSessions: 2 }),
    ).rejects.toThrow("Session key exceeds maxSessions");
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("createSession allows existing session even if maxSessions lowered", async () => {
    const tempDir = makeTempDir();
    const manager = new SessionManager({
      dataDir: tempDir,
    });
    await manager.createSession("group-1", "user-1", {
      key: 1,
      maxSessions: 2,
    });
    await expect(
      manager.createSession("group-1", "user-1", {
        key: 1,
        maxSessions: 1,
      }),
    ).resolves.toBeTruthy();
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("createSession rejects negative key", async () => {
    const tempDir = makeTempDir();
    const manager = new SessionManager({
      dataDir: tempDir,
    });
    await expect(
      manager.createSession("group-1", "user-1", { key: -1, maxSessions: 2 }),
    ).rejects.toThrow("Session key must be a non-negative integer");
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("createSession rejects unsafe groupId", async () => {
    const tempDir = makeTempDir();
    const manager = new SessionManager({
      dataDir: tempDir,
    });
    await expect(
      manager.createSession("../escape", "user-1", { key: 0, maxSessions: 1 }),
    ).rejects.toThrow("groupId must be a safe path segment");
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("createSession rejects unsafe userId", async () => {
    const tempDir = makeTempDir();
    const manager = new SessionManager({
      dataDir: tempDir,
    });
    await expect(
      manager.createSession("group-1", "user/1", { key: 0, maxSessions: 1 }),
    ).rejects.toThrow("userId must be a safe path segment");
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("appendHistory writes entries", async () => {
    const tempDir = makeTempDir();
    const manager = new SessionManager({
      dataDir: tempDir,
    });
    const session = await manager.createSession("group-1", "user-1", {
      key: 0,
      maxSessions: 1,
    });
    await manager.appendHistory(session, {
      role: "user",
      content: "hello",
      createdAt: "t",
    });
    const history = await manager.readHistory(session);
    expect(history).toEqual([
      {
        role: "user",
        content: "hello",
        createdAt: "t",
      },
    ]);
    rmSync(tempDir, { recursive: true, force: true });
  });
});
