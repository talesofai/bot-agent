import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import pino from "pino";

import { GroupFileRepository } from "../repository";

describe("GroupFileRepository language-aware agent prompt", () => {
  let testDir: string;
  let repo: GroupFileRepository;

  beforeEach(() => {
    testDir = join(tmpdir(), `group-repo-lang-test-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
    repo = new GroupFileRepository({
      dataDir: testDir,
      logger: pino({ level: "silent" }),
    });
  });

  afterEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  test("ensureGroupDir creates agent.md and agent.en.md", async () => {
    const groupPath = await repo.ensureGroupDir("g1");
    expect(existsSync(join(groupPath, "agent.md"))).toBe(true);
    expect(existsSync(join(groupPath, "agent.en.md"))).toBe(true);
  });

  test("loadAgentPromptForLanguage selects the matching file", async () => {
    const groupPath = await repo.ensureGroupDir("g2");
    writeFileSync(join(groupPath, "agent.md"), "ZH PROMPT");
    writeFileSync(join(groupPath, "agent.en.md"), "EN PROMPT");

    const zh = await repo.loadAgentPromptForLanguage(groupPath, "zh");
    const en = await repo.loadAgentPromptForLanguage(groupPath, "en");

    expect(zh.content).toBe("ZH PROMPT");
    expect(en.content).toBe("EN PROMPT");
  });

  test("group 0 falls back to default template when agent.en.md is empty", async () => {
    const groupPath = await repo.ensureGroupDir("0");
    writeFileSync(join(groupPath, "agent.en.md"), "");

    const en = await repo.loadAgentPromptForLanguage(groupPath, "en");
    expect(en.content).not.toBe("");
    expect(en.content).toContain("You are Naita");
  });
});
