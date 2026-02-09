import { describe, expect, test } from "bun:test";

import { normalizeDiscordAudioMarkup } from "../audio-markup";

describe("normalizeDiscordAudioMarkup", () => {
  test("converts html audio tags into readable lines and extracts urls", () => {
    const result = normalizeDiscordAudioMarkup(
      [
        '⚔️ 战斗背景音乐：<audio src="https://cdn.example.com/bgm.mp3" controls>人生游戏</audio>',
        "其他说明",
      ].join("\n"),
    );

    expect(result.content).toContain("⚔️ 战斗背景音乐：🎧 人生游戏");
    expect(result.content).toContain("其他说明");
    expect(result.content).not.toContain("<audio");
    expect(result.audioUrls).toEqual(["https://cdn.example.com/bgm.mp3"]);
  });

  test("extracts audio urls from plain text links", () => {
    const result = normalizeDiscordAudioMarkup(
      "配乐链接：https://oss.example.com/scene/theme.ogg",
    );

    expect(result.content).toContain("https://oss.example.com/scene/theme.ogg");
    expect(result.audioUrls).toEqual([
      "https://oss.example.com/scene/theme.ogg",
    ]);
  });

  test("deduplicates repeated audio urls", () => {
    const result = normalizeDiscordAudioMarkup(
      [
        '<audio src="https://oss.example.com/a.mp3">A</audio>',
        "https://oss.example.com/a.mp3",
      ].join("\n"),
    );

    expect(result.audioUrls).toEqual(["https://oss.example.com/a.mp3"]);
  });
});
