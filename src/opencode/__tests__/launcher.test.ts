import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { resetConfig } from "../../config";
import type { SessionInfo } from "../../types/session";
import { OpencodeLauncher } from "../launcher";

describe("OpencodeLauncher", () => {
  test("does not pass prompt via argv", () => {
    const launcher = new OpencodeLauncher();
    const prompt = "super-secret-prompt";
    return launcher.buildLaunchSpec(makeSessionInfo(), prompt).then((spec) => {
      expect(spec.args.join(" ")).not.toContain(prompt);
      expect(spec.prompt).toBe(prompt);
    });
  });

  test("enforces OPENCODE_PROMPT_MAX_BYTES", async () => {
    const prev = process.env.OPENCODE_PROMPT_MAX_BYTES;
    try {
      process.env.OPENCODE_PROMPT_MAX_BYTES = "8";
      resetConfig();
      const launcher = new OpencodeLauncher();
      await expect(
        launcher.buildLaunchSpec(makeSessionInfo(), "123456789"),
      ).rejects.toThrow();
    } finally {
      if (prev === undefined) {
        delete process.env.OPENCODE_PROMPT_MAX_BYTES;
      } else {
        process.env.OPENCODE_PROMPT_MAX_BYTES = prev;
      }
      resetConfig();
    }
  });

  test("uses yolo agent by default even for glm", async () => {
    const tempHome = mkdtempSync(path.join(tmpdir(), "opencode-home-"));
    const prevEnv = pickEnv([
      "HOME",
      "OPENAI_BASE_URL",
      "OPENAI_API_KEY",
      "OPENCODE_MODELS",
      "OPENCODE_YOLO",
    ]);

    try {
      process.env.HOME = tempHome;
      delete process.env.OPENAI_BASE_URL;
      delete process.env.OPENAI_API_KEY;
      delete process.env.OPENCODE_MODELS;
      delete process.env.OPENCODE_YOLO;

      resetConfig();
      const launcher = new OpencodeLauncher();
      const spec = await launcher.buildLaunchSpec(makeSessionInfo(), "hello");

      expect(spec.args).toContain("--agent");
      expect(spec.args).toContain("chat-yolo-responder");
      expect(spec.args).toContain("-m");
      expect(spec.args).toContain("opencode/glm-4.7-free");

      const agentPath = path.join(
        tempHome,
        ".config",
        "opencode",
        "agent",
        "chat-yolo-responder.md",
      );
      const agentFile = readFileSync(agentPath, "utf8");
      expect(agentFile).toContain("all tools enabled");
    } finally {
      restoreEnv(prevEnv);
      resetConfig();
      rmSync(tempHome, { recursive: true, force: true });
    }
  });

  test("can disable yolo agent via OPENCODE_YOLO", async () => {
    const tempHome = mkdtempSync(path.join(tmpdir(), "opencode-home-"));
    const prevEnv = pickEnv(["HOME", "OPENCODE_YOLO"]);

    try {
      process.env.HOME = tempHome;
      process.env.OPENCODE_YOLO = "false";

      resetConfig();
      const launcher = new OpencodeLauncher();
      const spec = await launcher.buildLaunchSpec(makeSessionInfo(), "hello");

      expect(spec.args).not.toContain("--agent");
      expect(spec.args).toContain("opencode/glm-4.7-free");
    } finally {
      restoreEnv(prevEnv);
      resetConfig();
      rmSync(tempHome, { recursive: true, force: true });
    }
  });
});

function makeSessionInfo(): SessionInfo {
  const now = new Date().toISOString();
  return {
    meta: {
      sessionId: "user-1:0",
      groupId: "group-1",
      botId: "bot-1",
      ownerId: "user-1",
      key: 0,
      status: "idle",
      createdAt: now,
      updatedAt: now,
    },
    groupPath: "/tmp/group-1",
    workspacePath: "/tmp/session-workspace",
    historyPath: "/tmp/history.sqlite",
  };
}

function pickEnv(keys: string[]): Record<string, string | undefined> {
  return Object.fromEntries(keys.map((key) => [key, process.env[key]]));
}

function restoreEnv(snapshot: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(snapshot)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}
