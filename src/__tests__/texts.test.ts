import { describe, expect, test } from "bun:test";

import {
  buildCharacterBuildAgentPrompt,
  buildDiscordCharacterBuildAutopilot,
  buildDiscordCharacterCreateGuide,
  buildDiscordHelp,
  buildDiscordOnboardingAutoPrompt,
  buildDiscordOnboardingGuide,
} from "../texts";

describe("Discord help/onboarding texts", () => {
  test("buildDiscordHelp (zh default) includes message commands and quick start", () => {
    const help = buildDiscordHelp(null);
    expect(help).toContain("新手导航");
    expect(help).toContain("消息命令");
    expect(help).toContain("/nano");
    expect(help).toContain("/polish");
    expect(help).toContain("/quest");
    expect(help).toContain(".rd 2d6");
    expect(help).toContain("Slash Commands");
  });

  test("buildDiscordHelp (en) includes message commands and slash commands", () => {
    const help = buildDiscordHelp("en");
    expect(help).toContain("Quick Start");
    expect(help).toContain("Message Commands");
    expect(help).toContain("/nano");
    expect(help).toContain("/polish");
    expect(help).toContain("/quest");
    expect(help).toContain(".rd 2d6");
    expect(help).toContain("Slash Commands");
  });

  test("buildDiscordOnboardingAutoPrompt mentions private thread and wake rules", () => {
    const prompt = buildDiscordOnboardingAutoPrompt(null);
    expect(prompt).toContain("私密");
    expect(prompt).toContain("无需 @");
    expect(prompt).toContain("/onboard role:adventurer");
    expect(prompt).toContain("/onboard role:world creater");
    expect(prompt).toContain("/nano");
    expect(prompt).toContain(".rd 2d6");
  });

  test("buildDiscordOnboardingGuide (world creater zh) includes world workflow and recovery hint", () => {
    const guide = buildDiscordOnboardingGuide({
      role: "world creater",
      language: null,
    });
    expect(guide).toContain("世界创建者");
    expect(guide).toContain("/world create");
    expect(guide).toContain("/world publish");
    expect(guide).toContain("找不到");
    expect(guide).toContain("/onboard role:world creater");
  });

  test("buildDiscordOnboardingGuide (adventurer en) includes workflow and wake hint", () => {
    const guide = buildDiscordOnboardingGuide({
      role: "adventurer",
      language: "en",
    });
    expect(guide).toContain("Adventurer Guide");
    expect(guide).toContain("/character create");
    expect(guide).toContain("/world join");
    expect(guide).toContain("no @ needed");
  });

  test("buildDiscordCharacterCreateGuide (zh) mentions uploads and library wording", () => {
    const guide = buildDiscordCharacterCreateGuide({
      characterId: 1,
      language: null,
    });
    expect(guide).toContain("上传");
    expect(guide).toContain("角色图书馆");
    expect(guide).toContain("/character publish");
  });

  test("buildDiscordCharacterBuildAutopilot (zh) uses library/product wording", () => {
    const prompt = buildDiscordCharacterBuildAutopilot({
      characterId: 1,
      characterName: "Test",
      language: null,
    });
    expect(prompt).toContain("角色图书馆");
    expect(prompt).toContain("角色卡");
    expect(prompt).not.toContain("character/source.md");
    expect(prompt).not.toContain("character/character-card.md");
  });

  test("buildCharacterBuildAgentPrompt mentions character/source.md", () => {
    const prompt = buildCharacterBuildAgentPrompt({
      characterId: 1,
      characterName: "Test",
      language: null,
    });
    expect(prompt).toContain("character/source.md");
    expect(prompt).toContain("character/character-card.md");
  });
});
