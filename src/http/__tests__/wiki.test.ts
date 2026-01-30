import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import pino from "pino";

import { handleHttpRequest, type HttpRequestHandlerContext } from "../server";

describe("/wiki", () => {
  test("serves index + README + sidebar even when dataRoot is empty", async () => {
    const logger = pino({ level: "silent" });
    const dataRoot = await mkdtemp(path.join(os.tmpdir(), "wiki-empty-"));
    const context: HttpRequestHandlerContext = {
      logger,
      startedAt: 0,
      version: "test",
      apiToken: null,
      dataRoot,
    };

    const index = await handleHttpRequest(
      new Request("http://test/wiki"),
      context,
    );
    expect(index.status).toBe(200);
    expect(await index.text()).toContain("docsify");

    const readme = await handleHttpRequest(
      new Request("http://test/wiki/README.md"),
      context,
    );
    expect(readme.status).toBe(200);
    expect(await readme.text()).toContain("只读");

    const sidebar = await handleHttpRequest(
      new Request("http://test/wiki/_sidebar.md"),
      context,
    );
    expect(sidebar.status).toBe(200);
    const sidebarText = await sidebar.text();
    expect(sidebarText).toContain("世界 Worlds");
    expect(sidebarText).toContain("角色 Characters");
  });

  test("lists worlds/characters and serves markdown from dataRoot", async () => {
    const logger = pino({ level: "silent" });
    const dataRoot = await mkdtemp(path.join(os.tmpdir(), "wiki-data-"));

    const worldDir = path.join(dataRoot, "worlds", "1", "canon");
    await mkdir(worldDir, { recursive: true });
    await writeFile(
      path.join(dataRoot, "worlds", "1", "world-card.md"),
      ["# 世界观设计卡（W1）", "", "- 世界名称：测试世界", ""].join("\n"),
      "utf8",
    );
    await writeFile(
      path.join(dataRoot, "worlds", "1", "rules.md"),
      "# rules\n",
      "utf8",
    );
    await writeFile(path.join(worldDir, "canon.md"), "# canon\n", "utf8");

    const characterDir = path.join(dataRoot, "characters");
    await mkdir(characterDir, { recursive: true });
    await writeFile(
      path.join(characterDir, "2.md"),
      ["# 角色卡（C2）", "", "- 角色名：阿猫", ""].join("\n"),
      "utf8",
    );

    const context: HttpRequestHandlerContext = {
      logger,
      startedAt: 0,
      version: "test",
      apiToken: null,
      dataRoot,
    };

    const sidebar = await handleHttpRequest(
      new Request("http://test/wiki/_sidebar.md"),
      context,
    );
    expect(sidebar.status).toBe(200);
    const sidebarText = await sidebar.text();
    expect(sidebarText).toContain("W1 测试世界");
    expect(sidebarText).toContain("C2 阿猫");

    const card = await handleHttpRequest(
      new Request("http://test/wiki/worlds/W1/world-card.md"),
      context,
    );
    expect(card.status).toBe(200);
    expect(await card.text()).toContain("测试世界");

    const canon = await handleHttpRequest(
      new Request("http://test/wiki/worlds/W1/canon/canon.md"),
      context,
    );
    expect(canon.status).toBe(200);
    expect(await canon.text()).toContain("# canon");
  });

  test("rejects unsafe canon filenames", async () => {
    const logger = pino({ level: "silent" });
    const dataRoot = await mkdtemp(path.join(os.tmpdir(), "wiki-unsafe-"));
    const context: HttpRequestHandlerContext = {
      logger,
      startedAt: 0,
      version: "test",
      apiToken: null,
      dataRoot,
    };

    const bad = await handleHttpRequest(
      new Request("http://test/wiki/worlds/W1/canon/%2Fetc%2Fpasswd"),
      context,
    );
    expect(bad.status).toBe(400);
  });
});
