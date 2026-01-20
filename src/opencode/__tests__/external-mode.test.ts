import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { resetConfig } from "../../config";
import type { SessionInfo } from "../../types/session";
import { OpencodeLauncher } from "../launcher";

describe("OpencodeLauncher external mode", () => {
  test("uses litellm/<model> and writes opencode config/auth files", async () => {
    const tempHome = mkdtempSync(path.join(tmpdir(), "opencode-home-"));
    const prevEnv = pickEnv([
      "HOME",
      "OPENAI_BASE_URL",
      "OPENAI_API_KEY",
      "OPENCODE_MODELS",
    ]);
    let generatedHome: string | undefined;

    try {
      process.env.HOME = tempHome;
      process.env.OPENAI_BASE_URL = "http://127.0.0.1:8124/v1";
      process.env.OPENAI_API_KEY = "sk-test";
      process.env.OPENCODE_MODELS = "gpt-5.2,gpt-5.1";

      resetConfig();
      const launcher = new OpencodeLauncher();
      const spec = await launcher.buildLaunchSpec(
        makeSessionInfo(),
        "hello",
        "gpt-5.1",
      );

      expect(spec.args).toContain("--agent");
      expect(spec.args).toContain("chat-yolo-responder");
      expect(spec.args).toContain("-m");
      expect(spec.args).toContain("litellm/gpt-5.1");
      expect(spec.env?.HOME).toBeTruthy();
      expect(spec.env?.HOME).not.toBe(tempHome);
      const resolvedHome = spec.env?.HOME;
      if (!resolvedHome) {
        throw new Error(
          "Expected OpencodeLauncher to set HOME for external mode",
        );
      }
      generatedHome = resolvedHome;
      expect(spec.cleanupPaths ?? []).toContain(resolvedHome);
      expect(spec.env?.OPENCODE_CONFIG).toBe(
        path.join(resolvedHome, ".config", "opencode", "opencode.json"),
      );

      const configPath = path.join(
        resolvedHome,
        ".config",
        "opencode",
        "opencode.json",
      );
      const authPath = path.join(
        resolvedHome,
        ".local",
        "share",
        "opencode",
        "auth.json",
      );
      const agentPath = path.join(
        resolvedHome,
        ".config",
        "opencode",
        "agent",
        "chat-yolo-responder.md",
      );

      const configJson = JSON.parse(
        readFileSync(configPath, "utf8"),
      ) as OpencodeConfig;
      expect(configJson.provider.litellm.options.baseURL).toBe(
        "http://127.0.0.1:8124/v1",
      );
      expect(Object.keys(configJson.provider.litellm.models)).toEqual([
        "gpt-5.2",
        "gpt-5.1",
      ]);

      const authJson = JSON.parse(
        readFileSync(authPath, "utf8"),
      ) as OpencodeAuth;
      expect(authJson.litellm.type).toBe("api");
      expect(authJson.litellm.key).toBe("sk-test");

      const agentFile = readFileSync(agentPath, "utf8");
      expect(agentFile).toContain("all tools enabled");
    } finally {
      restoreEnv(prevEnv);
      resetConfig();
      if (generatedHome) {
        rmSync(generatedHome, { recursive: true, force: true });
      }
      rmSync(tempHome, { recursive: true, force: true });
    }
  });

  test("attaches trace headers to litellm requests when traceId is provided", async () => {
    const tempHome = mkdtempSync(path.join(tmpdir(), "opencode-home-"));
    const prevEnv = pickEnv([
      "HOME",
      "OPENAI_BASE_URL",
      "OPENAI_API_KEY",
      "OPENCODE_MODELS",
    ]);
    let generatedHome: string | undefined;

    try {
      process.env.HOME = tempHome;
      process.env.OPENAI_BASE_URL = "http://127.0.0.1:8124/v1";
      process.env.OPENAI_API_KEY = "sk-test";
      process.env.OPENCODE_MODELS = "gpt-5.2,gpt-5.1";

      resetConfig();
      const launcher = new OpencodeLauncher();
      const traceId = "040f7b70e5933b5ebb0155c02319d6a4";
      const spec = await launcher.buildLaunchSpec(
        makeSessionInfo(),
        "hello",
        "gpt-5.1",
        { traceId },
      );

      const resolvedHome = spec.env?.HOME;
      if (!resolvedHome) {
        throw new Error(
          "Expected OpencodeLauncher to set HOME for external mode",
        );
      }
      generatedHome = resolvedHome;

      const configPath = path.join(
        resolvedHome,
        ".config",
        "opencode",
        "opencode.json",
      );

      const configJson = JSON.parse(
        readFileSync(configPath, "utf8"),
      ) as OpencodeConfig;

      for (const model of ["gpt-5.2", "gpt-5.1"]) {
        const entry = configJson.provider.litellm.models[model];
        expect(entry.headers?.["x-opencode-trace-id"]).toBe(traceId);
        expect(entry.headers?.traceparent).toMatch(
          /^00-[a-f0-9]{32}-[a-f0-9]{16}-0[01]$/,
        );
      }
    } finally {
      restoreEnv(prevEnv);
      resetConfig();
      if (generatedHome) {
        rmSync(generatedHome, { recursive: true, force: true });
      }
      rmSync(tempHome, { recursive: true, force: true });
    }
  });

  test("falls back to the first allowed model when override is invalid", async () => {
    const tempHome = mkdtempSync(path.join(tmpdir(), "opencode-home-"));
    const prevEnv = pickEnv([
      "HOME",
      "OPENAI_BASE_URL",
      "OPENAI_API_KEY",
      "OPENCODE_MODELS",
    ]);
    let generatedHome: string | undefined;

    try {
      process.env.HOME = tempHome;
      process.env.OPENAI_BASE_URL = "http://127.0.0.1:8124/v1";
      process.env.OPENAI_API_KEY = "sk-test";
      process.env.OPENCODE_MODELS = "gpt-5.2,gpt-5.1";

      resetConfig();
      const launcher = new OpencodeLauncher();
      const spec = await launcher.buildLaunchSpec(
        makeSessionInfo(),
        "hello",
        "nope",
      );

      expect(spec.args).toContain("litellm/gpt-5.2");
      generatedHome = spec.env?.HOME ?? undefined;
    } finally {
      restoreEnv(prevEnv);
      resetConfig();
      if (generatedHome) {
        rmSync(generatedHome, { recursive: true, force: true });
      }
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
  };
}

type OpencodeConfig = {
  provider: {
    litellm: {
      options: {
        baseURL: string;
      };
      models: Record<
        string,
        { name: string; headers?: Record<string, string> | undefined }
      >;
    };
  };
};

type OpencodeAuth = {
  litellm: {
    type: string;
    key: string;
  };
};

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
