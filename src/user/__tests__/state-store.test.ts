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
        language: "zh",
        characterCreatedAt: "t",
      });
      expect(created.userId).toBe(userId);
      expect(created.role).toBe("player");
      expect(created.language).toBe("zh");
      expect(created.version).toBe(3);

      const loaded = await store.read(userId);
      expect(loaded).not.toBeNull();
      expect(loaded?.role).toBe("player");
      expect(loaded?.language).toBe("zh");
      expect(loaded?.characterCreatedAt).toBe("t");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("sets onboarding thread ids by role", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "user-state-"));
    try {
      const store = new UserStateStore({ dataRoot: dir });
      await store.setOnboardingThreadId({
        userId: "456",
        role: "player",
        threadId: "t1",
      });
      await store.setOnboardingThreadId({
        userId: "456",
        role: "creator",
        threadId: "t2",
      });
      const loaded = await store.read("456");
      expect(loaded?.onboardingThreadIds?.player).toBe("t1");
      expect(loaded?.onboardingThreadIds?.creator).toBe("t2");
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
