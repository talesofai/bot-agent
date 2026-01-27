import { describe, expect, test } from "bun:test";

import {
  buildWorldBuildGroupId,
  buildWorldCharacterBuildGroupId,
  buildWorldGroupId,
  parseWorldGroup,
  parseWorldGroupId,
} from "../ids";

describe("world ids", () => {
  test("parses play/build group ids", () => {
    expect(buildWorldGroupId(1)).toBe("world_1");
    expect(buildWorldBuildGroupId(2)).toBe("world_2_build");
    expect(buildWorldCharacterBuildGroupId(2, 3)).toBe(
      "world_2_character_3_build",
    );

    expect(parseWorldGroup("world_12")).toEqual({ kind: "play", worldId: 12 });
    expect(parseWorldGroup("world_12_build")).toEqual({
      kind: "build",
      worldId: 12,
    });
    expect(parseWorldGroup("world_12_character_8_build")).toEqual({
      kind: "character_build",
      worldId: 12,
      characterId: 8,
    });
    expect(parseWorldGroupId("world_12")).toBe(12);
    expect(parseWorldGroupId("world_12_build")).toBe(12);
    expect(parseWorldGroupId("world_12_character_8_build")).toBe(12);
  });
});
