import { describe, expect, test } from "bun:test";

import {
  buildDiscordOnboardingIdentityRoleConfig,
  resolveDiscordIdentityRoles,
} from "../onboarding-identity";

describe("Discord onboarding identity role mapping", () => {
  test("falls back to heuristics when config is empty", () => {
    const config = buildDiscordOnboardingIdentityRoleConfig({});

    expect(
      resolveDiscordIdentityRoles({
        memberRoleIds: [],
        memberRoleNames: ["🌍 I'm a worldbuilder / writer"],
        config,
      }),
    ).toEqual({ worldCreater: true, adventurer: false });

    expect(
      resolveDiscordIdentityRoles({
        memberRoleIds: [],
        memberRoleNames: ["⚔️ I want to roleplay / explore"],
        config,
      }),
    ).toEqual({ worldCreater: false, adventurer: true });

    expect(
      resolveDiscordIdentityRoles({
        memberRoleIds: [],
        memberRoleNames: ["⭐ Both! I create and play"],
        config,
      }),
    ).toEqual({ worldCreater: false, adventurer: false });

    expect(
      resolveDiscordIdentityRoles({
        memberRoleIds: [],
        memberRoleNames: ["adventurer"],
        config,
      }),
    ).toEqual({ worldCreater: false, adventurer: true });

    expect(
      resolveDiscordIdentityRoles({
        memberRoleIds: [],
        memberRoleNames: ["world creater"],
        config,
      }),
    ).toEqual({ worldCreater: true, adventurer: false });

    expect(
      resolveDiscordIdentityRoles({
        memberRoleIds: [],
        memberRoleNames: ["adventurer", "world creater"],
        config,
      }),
    ).toEqual({ worldCreater: true, adventurer: true });
  });

  test("matches role ids when configured", () => {
    const config = buildDiscordOnboardingIdentityRoleConfig({
      creatorRoleIdsRaw: "123,not-a-number",
      playerRoleIdsRaw: "456",
    });
    expect(config.worldCreaterRoleIds).toEqual(["123"]);
    expect(config.adventurerRoleIds).toEqual(["456"]);

    expect(
      resolveDiscordIdentityRoles({
        memberRoleIds: ["123"],
        memberRoleNames: ["whatever"],
        config,
      }),
    ).toEqual({ worldCreater: true, adventurer: false });

    expect(
      resolveDiscordIdentityRoles({
        memberRoleIds: ["456"],
        memberRoleNames: ["whatever"],
        config,
      }),
    ).toEqual({ worldCreater: false, adventurer: true });
  });

  test("matches role names by case-insensitive substring when configured", () => {
    const config = buildDiscordOnboardingIdentityRoleConfig({
      creatorRoleNamesRaw: "创作者,WorldBuilder",
      playerRoleNamesRaw: "ROLEPLAY,玩家",
    });

    expect(
      resolveDiscordIdentityRoles({
        memberRoleIds: [],
        memberRoleNames: ["【创作者】"],
        config,
      }),
    ).toEqual({ worldCreater: true, adventurer: false });

    expect(
      resolveDiscordIdentityRoles({
        memberRoleIds: [],
        memberRoleNames: ["i am a WORLDbuilder / writer"],
        config,
      }),
    ).toEqual({ worldCreater: true, adventurer: false });

    expect(
      resolveDiscordIdentityRoles({
        memberRoleIds: [],
        memberRoleNames: ["I want to RolePlay"],
        config,
      }),
    ).toEqual({ worldCreater: false, adventurer: true });
  });

  test("does not block heuristics when explicit config is present", () => {
    const config = buildDiscordOnboardingIdentityRoleConfig({
      playerRoleIdsRaw: "456",
    });

    expect(
      resolveDiscordIdentityRoles({
        memberRoleIds: [],
        memberRoleNames: ["worldbuilder"],
        config,
      }),
    ).toEqual({ worldCreater: true, adventurer: false });
  });

  test("does not map 'both' keyword specially", () => {
    const config = buildDiscordOnboardingIdentityRoleConfig({
      creatorRoleNamesRaw: "world creater",
    });

    expect(
      resolveDiscordIdentityRoles({
        memberRoleIds: [],
        memberRoleNames: ["both"],
        config,
      }),
    ).toEqual({ worldCreater: false, adventurer: false });
  });
});
