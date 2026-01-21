import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { SessionJob } from "../../queue";
import type { SessionInfo } from "../../types/session";
import { ShellOpencodeRunner } from "../runner";

describe("ShellOpencodeRunner", () => {
  test("injects prompt file after positional message", async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), "runner-test-"));
    const scriptPath = path.join(tempDir, "fake-opencode.ts");

    try {
      await writeFile(
        scriptPath,
        [
          'import { existsSync } from "node:fs";',
          "",
          "const args = process.argv.slice(2);",
          'const fileIndex = args.indexOf("--file");',
          "const filePath = fileIndex >= 0 ? args[fileIndex + 1] : null;",
          "const payload = {",
          "  args,",
          "  filePathExists: filePath ? existsSync(filePath) : false,",
          "};",
          "console.log(JSON.stringify({ output: JSON.stringify(payload) }));",
          "",
        ].join("\n"),
        { encoding: "utf8" },
      );

      const runner = new ShellOpencodeRunner();
      const message = "this-is-the-message";
      const job: SessionJob = {
        id: "job",
        data: {
          botId: "bot",
          groupId: "group",
          sessionId: "session",
          userId: "user",
          key: 0,
          gateToken: "gate",
        },
      };
      const session: SessionInfo = {
        meta: {
          sessionId: "session",
          groupId: "group",
          botId: "bot",
          ownerId: "user",
          key: 0,
          status: "running",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
        groupPath: tempDir,
        workspacePath: tempDir,
      };
      const result = await runner.run({
        job,
        session,
        history: [],
        launchSpec: {
          command: process.execPath,
          args: [scriptPath, "run", message],
          cwd: tempDir,
          prompt: "hello from prompt",
        },
      });

      expect(result.output).toBeTruthy();
      const payload = JSON.parse(result.output as string) as {
        args: string[];
        filePathExists: boolean;
      };

      const messageIndex = payload.args.indexOf(message);
      const fileIndex = payload.args.indexOf("--file");
      expect(messageIndex).toBeGreaterThanOrEqual(0);
      expect(fileIndex).toBeGreaterThanOrEqual(0);
      expect(messageIndex).toBeLessThan(fileIndex);
      expect(payload.filePathExists).toBe(true);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("only passes allowlisted env plus explicit overrides", async () => {
    const prevSecret = process.env.RUNNER_TEST_SECRET;
    process.env.RUNNER_TEST_SECRET = "should-not-leak";

    const tempDir = await mkdtemp(path.join(tmpdir(), "runner-env-test-"));
    const scriptPath = path.join(tempDir, "fake-opencode-env.ts");

    try {
      await writeFile(
        scriptPath,
        [
          "const payload = {",
          "  secret: process.env.RUNNER_TEST_SECRET ?? null,",
          "  nietaToken: process.env.NIETA_TOKEN ?? null,",
          "  hasPath: Boolean(process.env.PATH),",
          "};",
          "console.log(JSON.stringify({ output: JSON.stringify(payload) }));",
          "",
        ].join("\n"),
        { encoding: "utf8" },
      );

      const runner = new ShellOpencodeRunner();
      const job: SessionJob = {
        id: "job",
        data: {
          botId: "bot",
          groupId: "group",
          sessionId: "session",
          userId: "user",
          key: 0,
          gateToken: "gate",
        },
      };
      const session: SessionInfo = {
        meta: {
          sessionId: "session",
          groupId: "group",
          botId: "bot",
          ownerId: "user",
          key: 0,
          status: "running",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
        groupPath: tempDir,
        workspacePath: tempDir,
      };

      const result = await runner.run({
        job,
        session,
        history: [],
        launchSpec: {
          command: process.execPath,
          args: [scriptPath],
          cwd: tempDir,
          env: {
            NIETA_TOKEN: "test-token",
          },
        },
      });

      expect(result.output).toBeTruthy();
      const payload = JSON.parse(result.output as string) as {
        secret: string | null;
        nietaToken: string | null;
        hasPath: boolean;
      };
      expect(payload.secret).toBeNull();
      expect(payload.nietaToken).toBe("test-token");
      expect(payload.hasPath).toBe(true);
    } finally {
      if (prevSecret === undefined) {
        delete process.env.RUNNER_TEST_SECRET;
      } else {
        process.env.RUNNER_TEST_SECRET = prevSecret;
      }
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
