import { describe, expect, test } from "bun:test";
import { extractOutputElements } from "../output-elements";

describe("extractOutputElements", () => {
  test("extracts markdown images into elements", () => {
    const output = "看这个：![cat](https://example.com/a.png) 结束";
    const result = extractOutputElements(output);

    expect(result.elements).toEqual([
      { type: "image", url: "https://example.com/a.png" },
    ]);
    expect(result.content).toBe("看这个： 结束");
  });

  test("allows embed-only messages", () => {
    const output = "![x](https://example.com/a.png)";
    const result = extractOutputElements(output);

    expect(result.elements).toEqual([
      { type: "image", url: "https://example.com/a.png" },
    ]);
    expect(result.content).toBe("");
  });

  test("extracts bare image URLs without stripping text", () => {
    const output = "https://example.com/a.png";
    const result = extractOutputElements(output);

    expect(result.elements).toEqual([
      { type: "image", url: "https://example.com/a.png" },
    ]);
    expect(result.content).toBe("https://example.com/a.png");
  });

  test("extracts markdown images without file extensions", () => {
    const output =
      "![x](https://encrypted-tbn0.gstatic.com/images?q=tbn:abc) done";
    const result = extractOutputElements(output);

    expect(result.elements).toEqual([
      {
        type: "image",
        url: "https://encrypted-tbn0.gstatic.com/images?q=tbn:abc",
      },
    ]);
    expect(result.content).toBe("done");
  });

  test("respects maxImages limit", () => {
    const output = [
      "![1](https://example.com/1.png)",
      "![2](https://example.com/2.png)",
      "![3](https://example.com/3.png)",
      "![4](https://example.com/4.png)",
      "![5](https://example.com/5.png)",
    ].join("\n");
    const result = extractOutputElements(output);

    expect(result.elements).toHaveLength(4);
    expect(result.elements[0]).toEqual({
      type: "image",
      url: "https://example.com/1.png",
    });
  });
});
