import { describe, expect, test } from "bun:test";

import { resetConfig } from "../../config";
import type { SessionInfo } from "../../types/session";
import { OpencodeLauncher } from "../launcher";

describe("OpencodeLauncher", () => {
  test("does not pass prompt via argv", () => {
    const launcher = new OpencodeLauncher();
    const prompt = "super-secret-prompt";
    const spec = launcher.buildLaunchSpec(makeSessionInfo(), prompt);
    expect(spec.args.join(" ")).not.toContain(prompt);
    expect(spec.prompt).toBe(prompt);
  });

  test("enforces OPENCODE_PROMPT_MAX_BYTES", () => {
    const prev = process.env.OPENCODE_PROMPT_MAX_BYTES;
    try {
      process.env.OPENCODE_PROMPT_MAX_BYTES = "8";
      resetConfig();
      const launcher = new OpencodeLauncher();
      expect(() =>
        launcher.buildLaunchSpec(makeSessionInfo(), "123456789"),
      ).toThrow();
    } finally {
      if (prev === undefined) {
        delete process.env.OPENCODE_PROMPT_MAX_BYTES;
      } else {
        process.env.OPENCODE_PROMPT_MAX_BYTES = prev;
      }
      resetConfig();
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
