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
    expect(result.commandActions).toBeNull();
  });

  test("allows embed-only messages", () => {
    const output = "![x](https://example.com/a.png)";
    const result = extractOutputElements(output);

    expect(result.elements).toEqual([
      { type: "image", url: "https://example.com/a.png" },
    ]);
    expect(result.content).toBe("");
    expect(result.commandActions).toBeNull();
  });

  test("extracts bare image URLs without stripping text", () => {
    const output = "https://example.com/a.png";
    const result = extractOutputElements(output);

    expect(result.elements).toEqual([
      { type: "image", url: "https://example.com/a.png" },
    ]);
    expect(result.content).toBe("https://example.com/a.png");
    expect(result.commandActions).toBeNull();
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
    expect(result.commandActions).toBeNull();
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
    expect(result.commandActions).toBeNull();
  });

  test("extracts command-actions block and strips protocol block", () => {
    const output = [
      "你现在可以执行下一步。",
      "```command-actions",
      '{"prompt":"建议先创建角色","actions":[{"action":"character_create","label":"创建角色"},{"action":"world_join","payload":"42"}]}',
      "```",
    ].join("\n");

    const result = extractOutputElements(output);

    expect(result.content).toBe("你现在可以执行下一步。");
    expect(result.commandActions).toEqual({
      prompt: "建议先创建角色",
      actions: [
        { action: "character_create", label: "创建角色" },
        { action: "world_join", payload: "42" },
      ],
    });
  });

  test("drops invalid command-actions payload but still strips block", () => {
    const output = ["继续聊。", "```command-actions", "not-a-json", "```"].join(
      "\n",
    );

    const result = extractOutputElements(output);

    expect(result.content).toBe("继续聊。");
    expect(result.commandActions).toBeNull();
  });

  test("filters invalid actions and payloads from command-actions", () => {
    const output = [
      "```command-actions",
      JSON.stringify({
        actions: [
          { action: "unknown" },
          { action: "world_join" },
          { action: "world_join", payload: "abc" },
          { action: "world_join", payload: "7" },
          { action: "world_join", payload: "7" },
          { action: "world_list" },
        ],
      }),
      "```",
    ].join("\n");

    const result = extractOutputElements(output);

    expect(result.content).toBe("");
    expect(result.commandActions).toEqual({
      actions: [
        { action: "world_join", payload: "7" },
        { action: "world_list" },
      ],
    });
  });
});
