import { describe, expect, test } from "bun:test";

import {
  buildMarkdownCardEmbeds,
  chunkEmbedsForDiscord,
} from "../markdown-cards";

describe("markdown-cards", () => {
  test("builds embeds with fields from bullet key-values", () => {
    const markdown = [
      `# 世界观设计卡（W1）`,
      ``,
      `- 世界名称：奇妙世界`,
      `- 一句话简介：测试世界`,
      `- 类型标签：奇幻`,
      ``,
      `## 世界背景`,
      `- 世界概述：这是一段描述`,
      `- 核心冲突：善恶之争`,
      ``,
    ].join("\n");

    const embeds = buildMarkdownCardEmbeds(markdown, {
      titlePrefix: "世界卡",
      maxEmbeds: 18,
      includeEmptyFields: true,
    });

    expect(embeds.length).toBeGreaterThan(0);

    const fields = embeds.flatMap((embed) => embed.fields ?? []);
    expect(fields.some((f) => f.name.includes("世界名称"))).toBe(true);
    expect(fields.some((f) => f.value.includes("奇妙世界"))).toBe(true);
  });

  test("splits long values into multiple fields", () => {
    const longValue = "a".repeat(2000);
    const markdown = [`# 角色卡（C1）`, ``, `- 背景：${longValue}`, ``].join(
      "\n",
    );

    const embeds = buildMarkdownCardEmbeds(markdown, {
      titlePrefix: "角色卡",
      maxEmbeds: 18,
      includeEmptyFields: true,
    });

    const backgroundFields = embeds
      .flatMap((embed) => embed.fields ?? [])
      .filter((field) => field.name.includes("背景"));

    expect(backgroundFields.length).toBeGreaterThan(1);
    expect(backgroundFields.every((field) => field.value.length <= 1024)).toBe(
      true,
    );
  });

  test("drops markdown separator lines from embed descriptions", () => {
    const markdown = [
      `# 世界观设计卡（W2）`,
      `## 字段-2. 社会设定`,
      `------------------------------|`,
      `| 字段 | 内容 |`,
      `| ---- | ---- |`,
      `| 政治体制 | 乌甸巨人议会 |`,
    ].join("\n");

    const embeds = buildMarkdownCardEmbeds(markdown, {
      titlePrefix: "世界卡",
      maxEmbeds: 18,
      includeEmptyFields: true,
    });

    const descriptions = embeds
      .map((embed) => embed.description ?? "")
      .join("\n");
    expect(descriptions).not.toContain("------------------------------|");
    expect(descriptions).not.toContain("| ---- | ---- |");

    const fields = embeds.flatMap((embed) => embed.fields ?? []);
    expect(fields.some((field) => field.name.includes("政治体制"))).toBe(true);
  });

  test("chunks embeds into groups of up to 10", () => {
    const embeds = Array.from({ length: 21 }, (_v, i) => ({
      title: `E${i + 1}`,
    }));

    const chunks = chunkEmbedsForDiscord(embeds, 10);
    expect(chunks.length).toBe(3);
    expect(chunks[0]?.length).toBe(10);
    expect(chunks[1]?.length).toBe(10);
    expect(chunks[2]?.length).toBe(1);
  });
});
