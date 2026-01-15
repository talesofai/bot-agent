import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
type GroupStoreType = import("../group").GroupStore;
let GroupStoreClass: typeof import("../group").GroupStore;

describe("GroupStore", () => {
  let testDir: string;
  let store: GroupStoreType;

  beforeEach(async () => {
    // Create a unique temp directory for each test
    testDir = join(tmpdir(), `group-store-test-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
    if (!GroupStoreClass) {
      ({ GroupStore: GroupStoreClass } = await import("../group"));
    }
    store = new GroupStoreClass({ dataDir: testDir });
  });

  afterEach(async () => {
    // Cleanup temp directory
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  describe("init", () => {
    test("should create data directory if not exists", async () => {
      const newDir = join(testDir, "new-data");
      const newStore = new GroupStoreClass({ dataDir: newDir });
      await newStore.init();
      expect(existsSync(newDir)).toBe(true);
    });

    test("should load existing groups", async () => {
      // Create a test group
      const groupPath = join(testDir, "123456");
      mkdirSync(groupPath, { recursive: true });
      writeFileSync(
        join(groupPath, "config.yaml"),
        "enabled: true\ntriggerMode: mention\n",
      );
      writeFileSync(
        join(groupPath, "agent.md"),
        "# Test Agent\n\nYou are helpful.",
      );

      store = new GroupStoreClass({ dataDir: testDir, preload: true });
      await store.init();

      const groups = store.listGroups();
      expect(groups.length).toBe(1);
      expect(groups[0].id).toBe("123456");
    });
  });

  describe("ensureGroupDir", () => {
    test("should create group directory with subdirs", async () => {
      await store.ensureGroupDir("789012");

      expect(existsSync(join(testDir, "789012"))).toBe(true);
      expect(existsSync(join(testDir, "789012", "skills"))).toBe(true);
      expect(existsSync(join(testDir, "789012", "assets"))).toBe(true);
      expect(existsSync(join(testDir, "789012", "assets", "images"))).toBe(
        true,
      );
      expect(existsSync(join(testDir, "789012", "agent.md"))).toBe(true);
      expect(existsSync(join(testDir, "789012", "config.yaml"))).toBe(true);
    });

    test("should not overwrite existing directory", async () => {
      const groupPath = join(testDir, "existing");
      mkdirSync(groupPath, { recursive: true });
      writeFileSync(join(groupPath, "agent.md"), "Custom content");

      await store.ensureGroupDir("existing");

      const content = Bun.file(join(groupPath, "agent.md")).text();
      expect(content).resolves.toBe("Custom content");
    });

    test("should reject unsafe group IDs", async () => {
      await expect(store.ensureGroupDir("../escape")).rejects.toThrow(
        "groupId must be a safe path segment",
      );
    });
  });

  describe("loadGroup", () => {
    test("should load group with config", async () => {
      const groupPath = join(testDir, "test-group");
      mkdirSync(groupPath, { recursive: true });
      writeFileSync(
        join(groupPath, "config.yaml"),
        `
enabled: true
triggerMode: keyword
keywords:
  - bot
  - help
`,
      );
      writeFileSync(join(groupPath, "agent.md"), "# Agent\n\nYou are helpful.");

      const group = await store.loadGroup("test-group");

      expect(group).not.toBeNull();
      expect(group!.config.enabled).toBe(true);
      expect(group!.config.triggerMode).toBe("keyword");
      expect(group!.config.keywords).toEqual(["bot", "help"]);
    });

    test("should load maxSessions from config", async () => {
      const groupPath = join(testDir, "multi-session");
      mkdirSync(groupPath, { recursive: true });
      writeFileSync(
        join(groupPath, "config.yaml"),
        `
maxSessions: 3
`,
      );
      writeFileSync(join(groupPath, "agent.md"), "# Agent\n\nYou are helpful.");

      const group = await store.loadGroup("multi-session");

      expect(group).not.toBeNull();
      expect(group!.config.maxSessions).toBe(3);
    });

    test("should parse agent.md with frontmatter", async () => {
      const groupPath = join(testDir, "agent-group");
      mkdirSync(groupPath, { recursive: true });
      writeFileSync(join(groupPath, "config.yaml"), "enabled: true\n");
      writeFileSync(
        join(groupPath, "agent.md"),
        `---
name: TestBot
version: 1.0.0
---
You are a helpful assistant.

Be friendly and concise.
`,
      );

      const group = await store.loadGroup("agent-group");

      expect(group).not.toBeNull();
      expect(group!.agentPrompt).toBe(
        "You are a helpful assistant.\n\nBe friendly and concise.",
      );
    });

    test("should load skills from skills directory", async () => {
      const groupPath = join(testDir, "skills-group");
      mkdirSync(groupPath, { recursive: true });
      writeFileSync(join(groupPath, "config.yaml"), "enabled: true\n");
      writeFileSync(join(groupPath, "agent.md"), "# Agent\n\nYou are helpful.");
      mkdirSync(join(groupPath, "skills"), { recursive: true });
      writeFileSync(
        join(groupPath, "skills", "draw.md"),
        "# Draw\n\nYou can draw images.",
      );
      writeFileSync(
        join(groupPath, "skills", "code.md"),
        "# Code\n\nYou can write code.",
      );

      const group = await store.loadGroup("skills-group");

      expect(group).not.toBeNull();
      expect(Object.keys(group!.skills).length).toBe(2);
      expect(Object.keys(group!.skills).sort()).toEqual(["code", "draw"]);
    });

    test("should return null for non-existent group", async () => {
      const group = await store.loadGroup("non-existent");
      expect(group).toBeNull();
    });

    test("should return null on invalid config", async () => {
      const groupPath = join(testDir, "invalid-config");
      mkdirSync(groupPath, { recursive: true });
      writeFileSync(join(groupPath, "config.yaml"), "invalid: yaml: content:");

      const group = await store.loadGroup("invalid-config");

      expect(group).toBeNull();
    });
  });

  describe("getGroup", () => {
    test("should return loaded group", async () => {
      const groupPath = join(testDir, "get-test");
      mkdirSync(groupPath, { recursive: true });
      writeFileSync(join(groupPath, "config.yaml"), "enabled: true");
      writeFileSync(join(groupPath, "agent.md"), "# Agent\n\nYou are helpful.");

      await store.loadGroup("get-test");

      const group = await store.getGroup("get-test");
      expect(group).not.toBeNull();
      expect(group!.id).toBe("get-test");
    });

    test("should return null for unloaded group", async () => {
      const group = await store.getGroup("not-loaded");
      expect(group).toBeNull();
    });
  });

  describe("onReload", () => {
    test("should register reload callback", () => {
      const callback = () => {};
      store.onReload(callback);
      // No error means success
      expect(true).toBe(true);
    });
  });
});
