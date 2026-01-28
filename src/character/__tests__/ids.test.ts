import { describe, expect, test } from "bun:test";

import {
  buildCharacterBuildGroupId,
  buildWorldCharacterBuildGroupId,
  parseCharacterGroup,
} from "../ids";

describe("character ids", () => {
  test("parses build group ids", () => {
    expect(buildCharacterBuildGroupId(1)).toBe("character_1_build");
    expect(parseCharacterGroup("character_12_build")).toEqual({
      kind: "build",
      characterId: 12,
    });
    expect(parseCharacterGroup("character_12")).toBeNull();
  });

  test("parses world character build group ids", () => {
    expect(
      buildWorldCharacterBuildGroupId({ worldId: 1, characterId: 2 }),
    ).toBe("world_1_character_2_build");
    expect(parseCharacterGroup("world_3_character_9_build")).toEqual({
      kind: "world_build",
      worldId: 3,
      characterId: 9,
    });
    expect(parseCharacterGroup("world_0_character_9_build")).toBeNull();
  });
});
