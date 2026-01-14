import { describe, expect, test } from "bun:test";

import { trimTextElements } from "../utils";

describe("trimTextElements", () => {
  test("removes empty leading text and trims next text element", () => {
    const elements = [
      { type: "text", text: "   " },
      { type: "image", url: "https://example.com/image.png" },
      { type: "text", text: "  hello" },
    ];

    const result = trimTextElements(elements);

    expect(result).toEqual([
      { type: "image", url: "https://example.com/image.png" },
      { type: "text", text: "hello" },
    ]);
  });

  test("removes empty trailing text and trims previous text element", () => {
    const elements = [
      { type: "text", text: "hello   " },
      { type: "image", url: "https://example.com/image.png" },
      { type: "text", text: "   " },
    ];

    const result = trimTextElements(elements);

    expect(result).toEqual([
      { type: "text", text: "hello" },
      { type: "image", url: "https://example.com/image.png" },
    ]);
  });
});
