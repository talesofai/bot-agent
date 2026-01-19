import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import pino from "pino";

import { RouterStore } from "../router";

describe("RouterStore", () => {
  const logger = pino({ level: "silent" });
  let rootDir: string;
  let store: RouterStore;

  beforeEach(async () => {
    rootDir = await mkdtemp(path.join(tmpdir(), "router-store-test-"));
    store = new RouterStore({ dataDir: rootDir, logger });
  });

  afterEach(async () => {
    await rm(rootDir, { recursive: true, force: true });
  });

  test("init creates router/global.yaml and bots directory", async () => {
    await store.init();

    const globalConfigPath = path.join(rootDir, "router", "global.yaml");
    const content = await readFile(globalConfigPath, "utf8");
    expect(content).toContain("keywords:");
    expect(content).toContain("echoRate:");
  });

  test("ensureBotConfig creates bots/{botId}/config.yaml", async () => {
    await store.ensureBotConfig("qq-123");

    const botConfigPath = path.join(rootDir, "bots", "qq-123", "config.yaml");
    const content = await readFile(botConfigPath, "utf8");
    expect(content).toContain("keywordRouting:");
    expect(content).toContain("echoRate: null");
  });

  test("ensureBotConfig does not overwrite existing config.yaml", async () => {
    const botDir = path.join(rootDir, "bots", "qq-123");
    await mkdir(botDir, { recursive: true });
    const botConfigPath = path.join(botDir, "config.yaml");
    await writeFile(botConfigPath, 'keywords: ["custom"]\n', "utf8");

    await store.ensureBotConfig("qq-123");

    const content = await readFile(botConfigPath, "utf8");
    expect(content).toBe('keywords: ["custom"]\n');
  });

  test("rejects unsafe bot ids", async () => {
    await expect(store.ensureBotConfig("../escape")).rejects.toThrow(
      "botId must be a safe path segment",
    );
  });
});
