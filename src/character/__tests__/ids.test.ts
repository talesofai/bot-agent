import { describe, expect, test } from "bun:test";

import { buildCharacterBuildGroupId, parseCharacterGroup } from "../ids";

describe("character ids", () => {
  test("parses build group ids", () => {
    expect(buildCharacterBuildGroupId(1)).toBe("character_1_build");
    expect(parseCharacterGroup("character_12_build")).toEqual({
      kind: "build",
      characterId: 12,
    });
    expect(parseCharacterGroup("character_12")).toBeNull();
  });
});
