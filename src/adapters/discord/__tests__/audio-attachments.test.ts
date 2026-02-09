import { describe, expect, test } from "bun:test";

import { resolveDiscordAudioAttachments } from "../audio-attachments";

describe("resolveDiscordAudioAttachments", () => {
  test("downloads external audio as attachment", async () => {
    const result = await resolveDiscordAudioAttachments(
      ["https://1.1.1.1/music/theme.mp3"],
      {
        fetchFn: async () =>
          new Response(new Uint8Array([1, 2, 3]), {
            status: 200,
            headers: {
              "content-type": "audio/mpeg",
              "content-length": "3",
            },
          }),
      },
    );

    expect(result.keptUrls).toEqual([]);
    expect(result.files).toHaveLength(1);
    expect(result.files[0].name).toBe("theme.mp3");
  });

  test("keeps url when response is not audio", async () => {
    const input = "https://1.1.1.1/not-audio.mp3";
    const result = await resolveDiscordAudioAttachments([input], {
      fetchFn: async () =>
        new Response("nope", {
          status: 200,
          headers: {
            "content-type": "text/plain",
          },
        }),
    });

    expect(result.files).toHaveLength(0);
    expect(result.keptUrls).toEqual([input]);
  });

  test("keeps url when content-length exceeds maxBytes", async () => {
    const input = "https://1.1.1.1/too-large.wav";
    const result = await resolveDiscordAudioAttachments([input], {
      maxBytes: 2,
      fetchFn: async () =>
        new Response(new Uint8Array([1, 2, 3]), {
          status: 200,
          headers: {
            "content-type": "audio/wav",
            "content-length": "3",
          },
        }),
    });

    expect(result.files).toHaveLength(0);
    expect(result.keptUrls).toEqual([input]);
  });

  test("blocks SSRF attempts to loopback/private hosts", async () => {
    const input = "http://127.0.0.1/secret.mp3";
    const result = await resolveDiscordAudioAttachments([input], {
      fetchFn: async () => {
        throw new Error("fetch should not be called");
      },
    });

    expect(result.files).toHaveLength(0);
    expect(result.keptUrls).toEqual([input]);
  });
});
