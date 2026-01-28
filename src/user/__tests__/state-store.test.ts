import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "bun:test";

import { UserStateStore } from "../state-store";

describe("UserStateStore", () => {
  it("roundtrips state file", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "user-state-"));
    try {
      const store = new UserStateStore({ dataRoot: dir });
      const userId = "123";
      const created = await store.upsert(userId, {
        role: "player",
        characterCreatedAt: "t",
      });
      expect(created.userId).toBe(userId);
      expect(created.role).toBe("player");
      expect(created.version).toBe(2);

      const loaded = await store.read(userId);
      expect(loaded).not.toBeNull();
      expect(loaded?.role).toBe("player");
      expect(loaded?.characterCreatedAt).toBe("t");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("markPrompted is idempotent", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "user-state-"));
    try {
      const store = new UserStateStore({ dataRoot: dir });
      const first = await store.markPrompted("456");
      const second = await store.markPrompted("456");
      expect(first.promptedAt).toBeDefined();
      expect(second.promptedAt).toBe(first.promptedAt);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("markWorldCreated is idempotent", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "user-state-"));
    try {
      const store = new UserStateStore({ dataRoot: dir });
      const first = await store.markWorldCreated("789");
      const second = await store.markWorldCreated("789");
      expect(first.worldCreatedAt).toBeDefined();
      expect(second.worldCreatedAt).toBe(first.worldCreatedAt);
      expect(second.role).toBe("creator");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
