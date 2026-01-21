import { describe, expect, test } from "bun:test";

import type { OpencodeClient } from "../../opencode/server-client";
import { OpencodeServerRunner } from "../runner";

function createFakeClient(responseText: string | null): {
  client: OpencodeClient;
  calls: Array<{ directory: string; sessionId: string; body: unknown }>;
} {
  const calls: Array<{ directory: string; sessionId: string; body: unknown }> =
    [];

  const client: OpencodeClient = {
    async createSession() {
      return { id: "ses_test" };
    },
    async getSession() {
      return { id: "ses_test" };
    },
    async prompt(input) {
      calls.push({
        directory: input.directory,
        sessionId: input.sessionId,
        body: input.body,
      });
      return {
        info: {
          id: "msg_test",
          sessionID: input.sessionId,
          role: "assistant",
        },
        parts:
          responseText === null
            ? []
            : [
                { type: "text", text: responseText },
                { type: "meta", ignored: true },
              ],
      };
    },
  };

  return { client, calls };
}

describe("OpencodeServerRunner", () => {
  test("extracts assistant text and emits history entry", async () => {
    const { client, calls } = createFakeClient("hello");
    const runner = new OpencodeServerRunner(client);
    const result = await runner.run({
      job: {
        id: "job",
        data: {
          botId: "bot",
          groupId: "group",
          sessionId: "session",
          userId: "user",
          key: 0,
          gateToken: "gate",
        },
      },
      session: {
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
        groupPath: "/tmp",
        workspacePath: "/tmp",
      },
      history: [],
      request: {
        directory: "/tmp/workspace",
        sessionId: "ses_test",
        body: {
          system: "sys",
          parts: [{ type: "text", text: "user" }],
        },
      },
    });

    expect(result.output).toBe("hello");
    expect(result.historyEntries?.[0]?.role).toBe("assistant");
    expect(result.historyEntries?.[0]?.content).toBe("hello");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      directory: "/tmp/workspace",
      sessionId: "ses_test",
    });
  });

  test("returns empty result when assistant message has no text", async () => {
    const { client } = createFakeClient(null);
    const runner = new OpencodeServerRunner(client);
    const result = await runner.run({
      job: {
        id: "job",
        data: {
          botId: "bot",
          groupId: "group",
          sessionId: "session",
          userId: "user",
          key: 0,
          gateToken: "gate",
        },
      },
      session: {
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
        groupPath: "/tmp",
        workspacePath: "/tmp",
      },
      history: [],
      request: {
        directory: "/tmp/workspace",
        sessionId: "ses_test",
        body: {
          parts: [{ type: "text", text: "user" }],
        },
      },
    });

    expect(result.output).toBeUndefined();
    expect(result.historyEntries).toBeUndefined();
  });

  test("throws when aborted before start", async () => {
    const { client } = createFakeClient("hello");
    const runner = new OpencodeServerRunner(client);
    const controller = new AbortController();
    controller.abort();

    await expect(
      runner.run({
        job: {
          id: "job",
          data: {
            botId: "bot",
            groupId: "group",
            sessionId: "session",
            userId: "user",
            key: 0,
            gateToken: "gate",
          },
        },
        session: {
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
          groupPath: "/tmp",
          workspacePath: "/tmp",
        },
        history: [],
        request: {
          directory: "/tmp/workspace",
          sessionId: "ses_test",
          body: {
            parts: [{ type: "text", text: "user" }],
          },
        },
        signal: controller.signal,
      }),
    ).rejects.toThrow("Opencode run aborted before start");
  });
});
