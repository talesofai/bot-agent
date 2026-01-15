import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import pino from "pino";

import type { SessionJob } from "../../queue";
import { GroupFileRepository } from "../../store/repository";
import { InMemoryHistoryStore } from "../../session/history";
import { SessionRepository } from "../../session/repository";
import { createSession } from "../../session/session-ops";
import { OpencodeLauncher } from "../launcher";
import { ShellOpencodeRunner } from "../../worker/runner";
import { buildSystemPrompt } from "../system-prompt";
import { buildOpencodePrompt } from "../prompt";

const integrationEnabled = process.env.OPENCODE_INTEGRATION === "1";
const integrationTest = integrationEnabled ? test : test.skip;

describe("opencode integration", () => {
  integrationTest("runs opencode and writes history", async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), "opencode-test-"));
    const logger = pino({ level: "silent" });
    const groupRepository = new GroupFileRepository({
      dataDir: tempDir,
      logger,
    });
    const sessionRepository = new SessionRepository({
      dataDir: tempDir,
      logger,
    });
    const historyStore = new InMemoryHistoryStore();
    const groupId = "group-1";
    const userId = "user-1";
    const key = 0;
    const historyKey = { botAccountId: "test:bot-1", userId };

    try {
      const opencodeBin = process.env.OPENCODE_BIN ?? "opencode";
      if (!process.env.OPENCODE_BIN) {
        const resolved = Bun.which(opencodeBin);
        if (!resolved) {
          throw new Error(
            "Missing opencode binary. Set OPENCODE_BIN or ensure opencode is on PATH.",
          );
        }
      }
      const session = await createSession({
        groupId,
        userId,
        key,
        groupRepository,
        sessionRepository,
      });
      const model = process.env.OPENCODE_MODEL ?? "glm-4.7";
      const launcher = new OpencodeLauncher();
      const runner = new ShellOpencodeRunner();

      const runTurn = async (input: string): Promise<void> => {
        const now = new Date().toISOString();
        await historyStore.appendHistory(historyKey, {
          role: "user",
          content: input,
          createdAt: now,
          groupId,
        });
        const history = await historyStore.readHistory(historyKey, {
          maxEntries: 20,
        });
        await groupRepository.ensureGroupDir(groupId);
        const groupPath = sessionRepository.getGroupPath(groupId);
        const agentContent = await groupRepository.loadAgentPrompt(groupPath);
        const agentPrompt = agentContent.content;
        const systemPrompt = buildSystemPrompt(agentPrompt);
        const prompt = buildOpencodePrompt({
          systemPrompt,
          history,
          input,
        });
        const launchSpec = launcher.buildLaunchSpec(session, prompt, model);
        launchSpec.command = opencodeBin;
        const job: SessionJob = {
          id: "opencode-integration",
          data: {
            groupId,
            sessionId: session.meta.sessionId,
            userId,
            key,
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
            await historyStore.appendHistory(historyKey, {
              ...entry,
              groupId,
            });
          }
          return;
        }
        if (result.output) {
          await historyStore.appendHistory(historyKey, {
            role: "assistant",
            content: result.output,
            createdAt,
            groupId,
          });
          return;
        }
        throw new Error("Opencode returned no output");
      };

      await runTurn("Say hi in one short sentence.");
      await runTurn("Now answer in one short sentence.");

      const updated = await historyStore.readHistory(historyKey, {
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
