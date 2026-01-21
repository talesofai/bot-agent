import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";

import { extractAssistantText, OpencodeServerClient } from "../server-client";

const opencodeEnabled = process.env.OPENCODE_SERVER_INTEGRATION === "1";
const opencodeAvailable =
  opencodeEnabled &&
  (await canReachOpencodeServer(process.env.OPENCODE_SERVER_URL));
const integrationTest = opencodeAvailable ? test : test.skip;

describe("opencode server integration", () => {
  integrationTest("creates session and prompts via server", async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), "opencode-test-"));

    try {
      const baseUrl =
        process.env.OPENCODE_SERVER_URL ?? "http://localhost:4096";
      const client = new OpencodeServerClient({
        baseUrl,
        username: process.env.OPENCODE_SERVER_USERNAME,
        password: process.env.OPENCODE_SERVER_PASSWORD,
        timeoutMs: 600_000,
      });
      const session = await client.createSession({
        directory: tempDir,
        title: "integration-test",
      });
      expect(session.id).toBeTruthy();

      const first = await client.prompt({
        directory: tempDir,
        sessionId: session.id,
        body: {
          system: "You are a helpful assistant.",
          parts: [{ type: "text", text: "Say hi in one short sentence." }],
        },
      });
      expect(extractAssistantText(first)).toBeTruthy();

      const second = await client.prompt({
        directory: tempDir,
        sessionId: session.id,
        body: {
          parts: [{ type: "text", text: "Now answer in one short sentence." }],
        },
      });
      expect(extractAssistantText(second)).toBeTruthy();
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});

async function canReachOpencodeServer(
  baseUrl: string | undefined,
): Promise<boolean> {
  const url = (baseUrl ?? "http://localhost:4096").replace(/\/+$/, "");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 2_000);
  try {
    await fetch(`${url}/session/invalid`, {
      method: "GET",
      headers: {
        "x-opencode-directory": "/tmp",
      },
      signal: controller.signal,
    });
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}
