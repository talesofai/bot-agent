import { describe, expect, test } from "bun:test";

import {
  applyWorldShowcaseCover,
  buildWorldShowcaseStarterContent,
} from "../world-showcase-message";

describe("world showcase message helpers", () => {
  test("buildWorldShowcaseStarterContent combines non-empty sections", () => {
    const result = buildWorldShowcaseStarterContent({
      opener: "  hello  ",
      content: "  world  ",
    });

    expect(result).toBe("hello\n\nworld");
  });

  test("applyWorldShowcaseCover keeps embeds when cover missing", () => {
    const input = [{ title: "W1" }];
    const result = applyWorldShowcaseCover({ embeds: input });

    expect(result.files).toHaveLength(0);
    expect(result.embeds).toEqual(input);
  });

  test("applyWorldShowcaseCover injects attachment image on first embed", () => {
    const result = applyWorldShowcaseCover({
      embeds: [{ title: "W2" }, { title: "Rules" }],
      cover: {
        filename: "cover.webp",
        buffer: Buffer.from([1, 2, 3]),
      },
    });

    expect(result.files).toHaveLength(1);
    expect(result.files[0]).toMatchObject({ name: "cover.webp" });
    expect(result.embeds[0]?.image?.url).toBe("attachment://cover.webp");
    expect(result.embeds[1]).toMatchObject({ title: "Rules" });
  });

  test("applyWorldShowcaseCover normalizes unsafe filename", () => {
    const result = applyWorldShowcaseCover({
      embeds: [{ title: "W3" }],
      cover: {
        filename: "../危险 文件",
        buffer: Buffer.from([9]),
      },
    });

    expect(result.files).toHaveLength(1);
    expect(result.files[0]?.name).toBe("world-cover.png");
    expect(result.embeds[0]?.image?.url).toBe("attachment://world-cover.png");
  });
});
