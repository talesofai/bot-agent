import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import pino from "pino";

import type { SessionJob } from "../../queue";
import type { HistoryEntry } from "../../types/session";
import { SessionManager, type SessionActivityTracker } from "../../session";
import { OpencodeLauncher } from "../launcher";
import { ShellOpencodeRunner } from "../../worker/runner";
import { buildSystemPrompt } from "../system-prompt";
import { buildOpencodePrompt } from "../prompt";

class MemoryActivityIndex implements SessionActivityTracker {
  async recordActivity(): Promise<void> {}
}

const integrationEnabled = process.env.OPENCODE_INTEGRATION === "1";
const integrationTest = integrationEnabled ? test : test.skip;

describe("opencode integration", () => {
  integrationTest("runs opencode and writes history", async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), "opencode-test-"));
    const logger = pino({ level: "silent" });
    const activityIndex = new MemoryActivityIndex();
    const sessionManager = new SessionManager({
      dataDir: tempDir,
      logger,
      activityIndex,
    });
    const groupId = "group-1";
    const userId = "user-1";
    const key = 0;

    try {
      const session = await sessionManager.createSession(groupId, userId, {
        key,
      });
      const model = process.env.OPENCODE_MODEL ?? "glm-4.7";
      const launcher = new OpencodeLauncher();
      const runner = new ShellOpencodeRunner();

      const runTurn = async (input: string): Promise<void> => {
        const now = new Date().toISOString();
        await sessionManager.appendHistory(session, {
          role: "user",
          content: input,
          createdAt: now,
        });
        const history = await sessionManager.readHistory(session, {
          maxEntries: 20,
        });
        const agentPrompt = await sessionManager.getAgentPrompt(groupId);
        const systemPrompt = buildSystemPrompt(agentPrompt);
        const prompt = buildOpencodePrompt({
          systemPrompt,
          history,
          input,
        });
        const launchSpec = launcher.buildLaunchSpec(session, prompt, model);
        if (process.env.OPENCODE_BIN) {
          launchSpec.command = process.env.OPENCODE_BIN;
        }
        const job: SessionJob = {
          id: "opencode-integration",
          data: {
            groupId,
            sessionId: session.meta.sessionId,
            userId,
            key,
            payload: {
              input: prompt,
              channelId: "channel-1",
              channelType: "group",
            },
          },
        };
        const result = await runner.run({
          job,
          session,
          history,
          launchSpec,
        });
        const createdAt = new Date().toISOString();
        if (result.historyEntries?.length) {
          for (const entry of result.historyEntries) {
            await sessionManager.appendHistory(session, entry);
          }
          return;
        }
        if (result.output) {
          await sessionManager.appendHistory(session, {
            role: "assistant",
            content: result.output,
            createdAt,
          });
          return;
        }
        throw new Error("Opencode returned no output");
      };

      await runTurn("Say hi in one short sentence.");
      await runTurn("Now answer in one short sentence.");

      const updated = await sessionManager.readHistory(session, {
        maxEntries: 50,
      });
      const assistantMessages = updated.filter(
        (entry) => entry.role === "assistant",
      );
      expect(assistantMessages.length).toBeGreaterThanOrEqual(2);
      const lastMessage = assistantMessages[assistantMessages.length - 1];
      expect(lastMessage.content.trim().length).toBeGreaterThan(0);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
