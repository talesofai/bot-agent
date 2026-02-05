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

    const root = await handleHttpRequest(new Request("http://test/"), context);
    expect(root.status).toBe(200);
    expect(await root.text()).toContain("docsify");

    const index = await handleHttpRequest(
      new Request("http://test/wiki"),
      context,
    );
    expect(index.status).toBe(200);
    const indexHtml = await index.text();
    expect(indexHtml).toContain("docsify");
    expect(indexHtml).toContain("subMaxLevel: 0");
    expect(indexHtml).not.toContain("sidebarDisplayLevel");

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
    expect(sidebarText).toContain("指令");
    expect(sidebarText).toContain("世界 Worlds");
    expect(sidebarText).toContain("角色 Characters");
  });

  test("supports i18n pages and serves command docs", async () => {
    const logger = pino({ level: "silent" });
    const dataRoot = await mkdtemp(path.join(os.tmpdir(), "wiki-i18n-"));
    const context: HttpRequestHandlerContext = {
      logger,
      startedAt: 0,
      version: "test",
      apiToken: null,
      dataRoot,
    };

    const enIndex = await handleHttpRequest(
      new Request("http://test/wiki/en"),
      context,
    );
    expect(enIndex.status).toBe(200);
    expect(await enIndex.text()).toContain("docsify");

    const enReadme = await handleHttpRequest(
      new Request("http://test/wiki/en/README.md"),
      context,
    );
    expect(enReadme.status).toBe(200);
    expect(await enReadme.text()).toContain("Read-only");

    const enSidebar = await handleHttpRequest(
      new Request("http://test/wiki/en/_sidebar.md"),
      context,
    );
    expect(enSidebar.status).toBe(200);
    const enSidebarText = await enSidebar.text();
    expect(enSidebarText).toContain("Commands");
    expect(enSidebarText).toContain("Worlds");
    expect(enSidebarText).toContain("Characters");

    const zhCommands = await handleHttpRequest(
      new Request("http://test/wiki/commands/README.md"),
      context,
    );
    expect(zhCommands.status).toBe(200);
    expect(await zhCommands.text()).toContain("Discord");

    const enCommands = await handleHttpRequest(
      new Request("http://test/wiki/en/commands/README.md"),
      context,
    );
    expect(enCommands.status).toBe(200);
    expect(await enCommands.text()).toContain("Discord");
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

    const cardShort = await handleHttpRequest(
      new Request("http://test/worlds/W1/world-card.md"),
      context,
    );
    expect(cardShort.status).toBe(200);
    expect(await cardShort.text()).toContain("测试世界");

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
