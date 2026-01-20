import { describe, expect, test } from "bun:test";
import { resolveDiscordImageAttachments } from "../image-attachments";
import type { SessionElement } from "../../../types/platform";

describe("resolveDiscordImageAttachments", () => {
  test("skips downloads for Discord CDN images", async () => {
    const elements: SessionElement[] = [
      { type: "image", url: "https://cdn.discordapp.com/a.png" },
    ];
    const result = await resolveDiscordImageAttachments(elements, {
      fetchFn: () => {
        throw new Error("fetch should not be called");
      },
    });

    expect(result.files).toHaveLength(0);
    expect(result.elements).toEqual(elements);
  });

  test("downloads external images as attachments", async () => {
    const elements: SessionElement[] = [
      { type: "image", url: "https://example.com/naita.png" },
    ];
    const result = await resolveDiscordImageAttachments(elements, {
      fetchFn: async () =>
        new Response(new Uint8Array([1, 2, 3]), {
          status: 200,
          headers: {
            "content-type": "image/png",
            "content-length": "3",
          },
        }),
    });

    expect(result.elements).toEqual([]);
    expect(result.files).toHaveLength(1);
    expect(result.files[0].name).toBe("naita.png");
  });

  test("adds extension when url has no filename extension", async () => {
    const elements: SessionElement[] = [
      { type: "image", url: "https://example.com/images?q=1" },
    ];
    const result = await resolveDiscordImageAttachments(elements, {
      fetchFn: async () =>
        new Response(new Uint8Array([1, 2, 3]), {
          status: 200,
          headers: {
            "content-type": "image/jpeg",
            "content-length": "3",
          },
        }),
    });

    expect(result.elements).toEqual([]);
    expect(result.files).toHaveLength(1);
    expect(result.files[0].name).toBe("images.jpg");
  });

  test("drops element when response is not an image", async () => {
    const elements: SessionElement[] = [
      { type: "image", url: "https://example.com/not-image.png" },
    ];
    const result = await resolveDiscordImageAttachments(elements, {
      fetchFn: async () =>
        new Response("nope", {
          status: 200,
          headers: {
            "content-type": "text/plain",
          },
        }),
    });

    expect(result.files).toHaveLength(0);
    expect(result.elements).toEqual([]);
  });

  test("keeps element when content-length exceeds maxBytes", async () => {
    const elements: SessionElement[] = [
      { type: "image", url: "https://example.com/big.png" },
    ];
    const result = await resolveDiscordImageAttachments(elements, {
      maxBytes: 2,
      fetchFn: async () =>
        new Response(new Uint8Array([1, 2, 3]), {
          status: 200,
          headers: {
            "content-type": "image/png",
            "content-length": "3",
          },
        }),
    });

    expect(result.files).toHaveLength(0);
    expect(result.elements).toEqual(elements);
  });
});
