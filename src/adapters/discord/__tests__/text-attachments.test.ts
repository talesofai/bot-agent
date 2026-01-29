import { describe, expect, test } from "bun:test";
import type { Attachment } from "discord.js";
import { strToU8, zipSync } from "fflate";

import { resetConfig } from "../../../config";
import { fetchDiscordTextAttachment } from "../text-attachments";

describe("fetchDiscordTextAttachment", () => {
  test("accepts json attachments by extension", async () => {
    const prevEnabled = process.env.SSRF_ALLOWLIST_ENABLED;
    const prevHosts = process.env.SSRF_ALLOWLIST_HOSTS;
    process.env.SSRF_ALLOWLIST_ENABLED = "true";
    process.env.SSRF_ALLOWLIST_HOSTS = "example.com";
    resetConfig();

    try {
      const bodyText = JSON.stringify({ hello: "world" });
      const attachment = {
        url: "https://example.com/world.json",
        name: "world.json",
        contentType: "application/json",
        size: Buffer.byteLength(bodyText, "utf8"),
      } as unknown as Attachment;
      const fetchFn = async () =>
        new Response(bodyText, {
          status: 200,
          headers: { "content-length": String(bodyText.length) },
        });

      const result = await fetchDiscordTextAttachment(attachment, {
        fetchFn,
        timeoutMs: 2000,
      });

      expect(result.filename).toBe("world.json");
      expect(result.content).toContain(`"hello"`);
    } finally {
      if (typeof prevEnabled === "string") {
        process.env.SSRF_ALLOWLIST_ENABLED = prevEnabled;
      } else {
        delete process.env.SSRF_ALLOWLIST_ENABLED;
      }
      if (typeof prevHosts === "string") {
        process.env.SSRF_ALLOWLIST_HOSTS = prevHosts;
      } else {
        delete process.env.SSRF_ALLOWLIST_HOSTS;
      }
      resetConfig();
    }
  });

  test("rejects attachments larger than maxBytes", async () => {
    const attachment = {
      url: "https://example.com/too-big.txt",
      name: "too-big.txt",
      contentType: "text/plain",
      size: 16,
    } as unknown as Attachment;

    await expect(
      fetchDiscordTextAttachment(attachment, { maxBytes: 8 }),
    ).rejects.toThrow(/attachment too large/i);
  });

  test("parses docx as plain text", async () => {
    const prevEnabled = process.env.SSRF_ALLOWLIST_ENABLED;
    const prevHosts = process.env.SSRF_ALLOWLIST_HOSTS;
    process.env.SSRF_ALLOWLIST_ENABLED = "true";
    process.env.SSRF_ALLOWLIST_HOSTS = "example.com";
    resetConfig();

    try {
      const xml = [
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`,
        `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">`,
        `<w:body>`,
        `<w:p><w:r><w:t>Hello</w:t></w:r></w:p>`,
        `<w:p><w:r><w:t>World</w:t></w:r></w:p>`,
        `</w:body>`,
        `</w:document>`,
      ].join("");
      const bytes = zipSync({ "word/document.xml": strToU8(xml) });

      const attachment = {
        url: "https://example.com/world.docx",
        name: "world.docx",
        contentType:
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        size: bytes.length,
      } as unknown as Attachment;

      const body = Uint8Array.from(bytes).buffer;
      const fetchFn = async () =>
        new Response(body, {
          status: 200,
          headers: { "content-length": String(bytes.length) },
        });

      const result = await fetchDiscordTextAttachment(attachment, {
        fetchFn,
        timeoutMs: 2000,
      });

      expect(result.filename).toBe("world.docx");
      expect(result.content).toContain("Hello");
      expect(result.content).toContain("World");
    } finally {
      if (typeof prevEnabled === "string") {
        process.env.SSRF_ALLOWLIST_ENABLED = prevEnabled;
      } else {
        delete process.env.SSRF_ALLOWLIST_ENABLED;
      }
      if (typeof prevHosts === "string") {
        process.env.SSRF_ALLOWLIST_HOSTS = prevHosts;
      } else {
        delete process.env.SSRF_ALLOWLIST_HOSTS;
      }
      resetConfig();
    }
  });
});
