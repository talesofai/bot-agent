import { describe, expect, test } from "bun:test";

import {
  buildWorldBuildGroupId,
  buildWorldGroupId,
  parseWorldGroup,
  parseWorldGroupId,
} from "../ids";

describe("world ids", () => {
  test("parses play/build group ids", () => {
    expect(buildWorldGroupId(1)).toBe("world_1");
    expect(buildWorldBuildGroupId(2)).toBe("world_2_build");

    expect(parseWorldGroup("world_12")).toEqual({ worldId: 12, kind: "play" });
    expect(parseWorldGroup("world_12_build")).toEqual({
      worldId: 12,
      kind: "build",
    });
    expect(parseWorldGroupId("world_12")).toBe(12);
    expect(parseWorldGroupId("world_12_build")).toBe(12);
  });
});
