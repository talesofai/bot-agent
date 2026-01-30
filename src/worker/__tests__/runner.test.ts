import { describe, expect, test } from "bun:test";

import type {
  OpencodeClient,
  OpencodeMessagePart,
} from "../../opencode/server-client";
import { OpencodeServerRunner } from "../runner";

type FakePromptResponse = {
  parts: OpencodeMessagePart[];
};

function createFakeClient(responses: FakePromptResponse[]): {
  client: OpencodeClient;
  calls: Array<{ directory: string; sessionId: string; body: unknown }>;
} {
  const calls: Array<{ directory: string; sessionId: string; body: unknown }> =
    [];
  let cursor = 0;

  const client: OpencodeClient = {
    async createSession() {
      return { id: "ses_test" };
    },
    async deleteSession() {
      return true;
    },
    async getSession() {
      return { id: "ses_test" };
    },
    async listMessages() {
      return [];
    },
    async prompt(input) {
      calls.push({
        directory: input.directory,
        sessionId: input.sessionId,
        body: input.body,
      });
      const response = responses[Math.min(cursor, responses.length - 1)];
      cursor += 1;
      return {
        info: {
          id: "msg_test",
          sessionID: input.sessionId,
          role: "assistant",
        },
        parts: response?.parts ?? [],
      };
    },
  };

  return { client, calls };
}

describe("OpencodeServerRunner", () => {
  test("extracts assistant text and emits history entry", async () => {
    const { client, calls } = createFakeClient([
      {
        parts: [
          { type: "text", text: "hello" },
          { type: "meta", ignored: true },
        ],
      },
    ]);
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
    const { client } = createFakeClient([{ parts: [] }]);
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

  test("captures webfetch URL and error message from tool part", async () => {
    const { client } = createFakeClient([
      {
        parts: [
          {
            type: "tool",
            tool: "webfetch",
            state: {
              status: "failed",
              input: { request: { url: "https://example.com/a" } },
              error: { message: "Request failed with status code: 403" },
            },
          },
          { type: "text", text: "ok" },
        ],
      },
    ]);
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

    expect(result.output).toBe("ok");
    expect(result.toolCalls).toBeTruthy();
    expect(result.toolCalls?.[0]).toMatchObject({
      tool: "webfetch",
      status: "failed",
      urls: ["https://example.com/a"],
      errorMessage: "Request failed with status code: 403",
    });
  });

  test("continues after tool-calls until text is available", async () => {
    const { client, calls } = createFakeClient([
      {
        parts: [
          { type: "tool", tool: "read", state: { status: "completed" } },
          { type: "step-finish", reason: "tool-calls" },
        ],
      },
      { parts: [{ type: "text", text: "final" }] },
    ]);
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

    expect(result.output).toBe("final");
    expect(calls).toHaveLength(2);
    expect(calls[1]?.body).toMatchObject({
      parts: [{ type: "text", text: " " }],
    });
  });

  test("formats question tool as plain text and requests user input", async () => {
    const { client } = createFakeClient([
      {
        parts: [
          {
            type: "tool",
            tool: "question",
            callID: "call_test",
            state: {
              status: "running",
              input: {
                questions: [
                  {
                    header: "设定补充需求",
                    question: "请补充以下必要信息：",
                    options: [
                      {
                        label: "世界基本设定",
                        description: "类型/背景/一句话简介",
                      },
                    ],
                  },
                ],
              },
            },
          },
        ],
      },
    ]);
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

    expect(result.output).toContain("设定补充需求");
    expect(result.output).toContain("世界基本设定");
    expect(result.pendingUserInput).toEqual({
      kind: "question",
      opencodeCallId: "call_test",
    });
  });

  test("throws when aborted before start", async () => {
    const { client } = createFakeClient([
      { parts: [{ type: "text", text: "hello" }] },
    ]);
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
