import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";

import { GroupFileRepository } from "../../store/repository";
import type { SessionEvent } from "../../types/platform";
import type { SessionJobData } from "../../queue";
import type {
  OpencodeRunner,
  OpencodeRunInput,
  OpencodeRunResult,
} from "../../worker/runner";
import type {
  PlatformAdapter,
  Bot,
  MessageHandler,
} from "../../types/platform";
import { OpencodeLauncher } from "../../opencode/launcher";
import { InMemoryHistoryStore } from "../history";
import { SessionRepository } from "../repository";
import { SessionProcessor } from "../processor";
import type { SessionActivityIndex } from "../activity-store";
import type { SessionBuffer, SessionBufferKey } from "../buffer";
import { buildBotAccountId } from "../../utils/bot-id";

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "session-processor-test-"));
}

class MemoryAdapter implements PlatformAdapter {
  platform = "test";
  messages: string[] = [];

  async connect(_bot: Bot): Promise<void> {}

  async disconnect(_bot: Bot): Promise<void> {}

  onEvent(_handler: MessageHandler): void {}

  async sendMessage(_session: SessionEvent, content: string): Promise<void> {
    this.messages.push(content);
  }

  getBotUserId(): string | null {
    return null;
  }
}

class CountingRunner implements OpencodeRunner {
  runs = 0;

  async run(): Promise<OpencodeRunResult> {
    this.runs += 1;
    return { output: `ok-${this.runs}` };
  }
}

class MemoryActivityIndex implements SessionActivityIndex {
  async recordActivity(): Promise<void> {}

  async close(): Promise<void> {}
}

class MemorySessionBuffer implements SessionBuffer {
  private buffers = new Map<string, SessionEvent[]>();
  private gates = new Map<string, string>();
  private gateTtlSeconds: number;
  private afterEmptyDrain: (() => void) | null = null;

  constructor(options?: { gateTtlSeconds?: number }) {
    this.gateTtlSeconds = options?.gateTtlSeconds ?? 60;
  }

  setAfterEmptyDrain(callback: () => void): void {
    this.afterEmptyDrain = callback;
  }

  getGateTtlSeconds(): number {
    return this.gateTtlSeconds;
  }

  async append(key: SessionBufferKey, message: SessionEvent): Promise<void> {
    const encoded = encodeKey(key);
    const existing = this.buffers.get(encoded) ?? [];
    existing.push(message);
    this.buffers.set(encoded, existing);
  }

  async requeueFront(
    key: SessionBufferKey,
    messages: ReadonlyArray<SessionEvent>,
  ): Promise<void> {
    if (messages.length === 0) {
      return;
    }
    const encoded = encodeKey(key);
    const existing = this.buffers.get(encoded) ?? [];
    this.buffers.set(encoded, [...messages, ...existing]);
  }

  async appendAndRequestJob(
    key: SessionBufferKey,
    message: SessionEvent,
    token: string,
  ): Promise<string | null> {
    await this.append(key, message);
    const encoded = encodeKey(key);
    if (!this.gates.has(encoded)) {
      this.gates.set(encoded, token);
      return token;
    }
    return null;
  }

  async drain(key: SessionBufferKey): Promise<SessionEvent[]> {
    const encoded = encodeKey(key);
    const existing = this.buffers.get(encoded) ?? [];
    if (existing.length > 0) {
      this.buffers.set(encoded, []);
      return existing;
    }
    if (this.afterEmptyDrain) {
      const callback = this.afterEmptyDrain;
      this.afterEmptyDrain = null;
      callback();
    }
    return [];
  }

  async claimGate(key: SessionBufferKey, token: string): Promise<boolean> {
    const encoded = encodeKey(key);
    const existing = this.gates.get(encoded);
    if (!existing) {
      this.gates.set(encoded, token);
      return true;
    }
    return existing === token;
  }

  async refreshGate(key: SessionBufferKey, token: string): Promise<boolean> {
    const encoded = encodeKey(key);
    return this.gates.get(encoded) === token;
  }

  async tryReleaseGate(key: SessionBufferKey, token: string): Promise<boolean> {
    const encoded = encodeKey(key);
    const existing = this.buffers.get(encoded) ?? [];
    if (existing.length !== 0) {
      return false;
    }
    const gate = this.gates.get(encoded);
    if (!gate) {
      return true;
    }
    if (gate !== token) {
      return false;
    }
    this.gates.delete(encoded);
    return true;
  }

  async releaseGate(key: SessionBufferKey, token: string): Promise<boolean> {
    const encoded = encodeKey(key);
    const gate = this.gates.get(encoded);
    if (gate === token) {
      this.gates.delete(encoded);
      return true;
    }
    return false;
  }

  hasGate(key: SessionBufferKey): boolean {
    return this.gates.has(encodeKey(key));
  }

  bufferLength(key: SessionBufferKey): number {
    return (this.buffers.get(encodeKey(key)) ?? []).length;
  }

  async close(): Promise<void> {}
}

function encodeKey(key: SessionBufferKey): string {
  return `${key.botId}:${key.groupId}:${key.sessionId}`;
}

describe("SessionProcessor", () => {
  test("stores stream events but excludes them from prompt history", async () => {
    const tempDir = makeTempDir();
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
    const adapter = new MemoryAdapter();
    const activityIndex = new MemoryActivityIndex();
    const bufferStore = new MemorySessionBuffer({ gateTtlSeconds: 3600 });
    const launcher = new OpencodeLauncher();

    const jobData: SessionJobData = {
      botId: "qq-123",
      groupId: "group-1",
      sessionId: "user-1-0",
      userId: "user-1",
      key: 0,
      gateToken: "gate-token",
    };
    const bufferKey: SessionBufferKey = {
      botId: jobData.botId,
      groupId: jobData.groupId,
      sessionId: jobData.sessionId,
    };

    const historyKey = {
      botAccountId: buildBotAccountId("qq", "123"),
      userId: jobData.userId,
    };
    const now = new Date().toISOString();
    await historyStore.appendHistory(historyKey, {
      role: "assistant",
      content: "visible",
      createdAt: now,
      groupId: jobData.groupId,
      sessionId: jobData.sessionId,
    });
    await historyStore.appendHistory(historyKey, {
      role: "system",
      content: "hidden",
      createdAt: now,
      groupId: jobData.groupId,
      sessionId: jobData.sessionId,
      includeInContext: false,
    });

    class TraceRunner implements OpencodeRunner {
      runs = 0;
      lastHistory: OpencodeRunInput["history"] = [];

      async run(input: OpencodeRunInput): Promise<OpencodeRunResult> {
        this.runs += 1;
        this.lastHistory = input.history;
        return {
          output: `ok-${this.runs}`,
          streamEvents: [
            { type: "thinking", text: "thought" },
            { type: "text", text: "delta" },
          ],
        };
      }
    }

    const runner = new TraceRunner();

    const processor = new SessionProcessor({
      logger,
      adapter,
      groupRepository,
      sessionRepository,
      historyStore,
      launcher,
      runner,
      activityIndex,
      bufferStore,
      limits: { historyEntries: 50, historyBytes: 50_000 },
    });

    try {
      const first: SessionEvent = {
        type: "message",
        platform: "qq",
        selfId: "123",
        userId: jobData.userId,
        guildId: jobData.groupId,
        channelId: jobData.groupId,
        messageId: "msg-1",
        content: "hello",
        elements: [{ type: "text", text: "hello" }],
        timestamp: Date.now(),
        extras: {},
      };
      const acquired = await bufferStore.appendAndRequestJob(
        bufferKey,
        first,
        jobData.gateToken,
      );
      expect(acquired).toBe(jobData.gateToken);

      await processor.process({ id: 0, data: jobData }, jobData);

      expect(runner.lastHistory.map((entry) => entry.content)).toEqual([
        "visible",
      ]);
      expect(adapter.messages).toEqual(["ok-1"]);

      const stored = await historyStore.readHistory(historyKey, {
        maxEntries: 20,
      });
      expect(stored.some((entry) => entry.includeInContext === false)).toBe(
        true,
      );

      const second: SessionEvent = {
        ...first,
        messageId: "msg-2",
        content: "next",
        elements: [{ type: "text", text: "next" }],
        timestamp: Date.now(),
      };
      const acquiredAgain = await bufferStore.appendAndRequestJob(
        bufferKey,
        second,
        jobData.gateToken,
      );
      expect(acquiredAgain).toBe(jobData.gateToken);

      await processor.process({ id: 1, data: jobData }, jobData);
      expect(
        runner.lastHistory.some((entry) => entry.includeInContext === false),
      ).toBe(false);
      expect(adapter.messages).toEqual(["ok-1", "ok-2"]);
    } finally {
      await processor.close();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("preserves numeric job id 0", async () => {
    const tempDir = makeTempDir();
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
    const adapter = new MemoryAdapter();
    const activityIndex = new MemoryActivityIndex();
    const bufferStore = new MemorySessionBuffer({ gateTtlSeconds: 3600 });
    const launcher = new OpencodeLauncher();

    const jobData: SessionJobData = {
      botId: "qq-123",
      groupId: "group-1",
      sessionId: "user-1-0",
      userId: "user-1",
      key: 0,
      gateToken: "gate-token",
    };
    const bufferKey: SessionBufferKey = {
      botId: jobData.botId,
      groupId: jobData.groupId,
      sessionId: jobData.sessionId,
    };

    const first: SessionEvent = {
      type: "message",
      platform: "qq",
      selfId: "123",
      userId: jobData.userId,
      guildId: jobData.groupId,
      channelId: jobData.groupId,
      messageId: "msg-1",
      content: "hello",
      elements: [{ type: "text", text: "hello" }],
      timestamp: Date.now(),
      extras: {},
    };

    const acquired = await bufferStore.appendAndRequestJob(
      bufferKey,
      first,
      jobData.gateToken,
    );
    expect(acquired).toBe(jobData.gateToken);

    class CapturingRunner implements OpencodeRunner {
      lastJobId: string | null = null;

      async run(input: OpencodeRunInput): Promise<OpencodeRunResult> {
        this.lastJobId = input.job.id;
        return { output: "ok" };
      }
    }

    const runner = new CapturingRunner();

    const processor = new SessionProcessor({
      logger,
      adapter,
      groupRepository,
      sessionRepository,
      historyStore,
      launcher,
      runner,
      activityIndex,
      bufferStore,
      limits: { historyEntries: 10, historyBytes: 10_000 },
    });

    try {
      await processor.process({ id: 0, data: jobData }, jobData);
    } finally {
      await processor.close();
      rmSync(tempDir, { recursive: true, force: true });
    }

    expect(runner.lastJobId).toBe("0");
    expect(adapter.messages).toEqual(["ok"]);
  });

  test("processes messages that arrive after an empty drain", async () => {
    const tempDir = makeTempDir();
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
    const runner = new CountingRunner();
    const adapter = new MemoryAdapter();
    const activityIndex = new MemoryActivityIndex();
    const bufferStore = new MemorySessionBuffer({ gateTtlSeconds: 3600 });
    const launcher = new OpencodeLauncher();

    const jobData: SessionJobData = {
      botId: "qq-123",
      groupId: "group-1",
      sessionId: "user-1-0",
      userId: "user-1",
      key: 0,
      gateToken: "gate-token",
    };
    const bufferKey: SessionBufferKey = {
      botId: jobData.botId,
      groupId: jobData.groupId,
      sessionId: jobData.sessionId,
    };

    const first: SessionEvent = {
      type: "message",
      platform: "qq",
      selfId: "123",
      userId: jobData.userId,
      guildId: jobData.groupId,
      channelId: jobData.groupId,
      messageId: "msg-1",
      content: "hello",
      elements: [{ type: "text", text: "hello" }],
      timestamp: Date.now(),
      extras: {},
    };
    const second: SessionEvent = {
      ...first,
      messageId: "msg-2",
      content: "second",
      elements: [{ type: "text", text: "second" }],
    };

    bufferStore.setAfterEmptyDrain(() => {
      void bufferStore.append(bufferKey, second);
    });

    const acquired = await bufferStore.appendAndRequestJob(
      bufferKey,
      first,
      jobData.gateToken,
    );
    expect(acquired).toBe(jobData.gateToken);
    expect(bufferStore.hasGate(bufferKey)).toBe(true);

    const processor = new SessionProcessor({
      logger,
      adapter,
      groupRepository,
      sessionRepository,
      historyStore,
      launcher,
      runner,
      activityIndex,
      bufferStore,
      limits: { historyEntries: 10, historyBytes: 10_000 },
    });

    try {
      await processor.process({ id: "job-1", data: jobData }, jobData);
    } finally {
      await processor.close();
      rmSync(tempDir, { recursive: true, force: true });
    }

    expect(runner.runs).toBe(2);
    expect(adapter.messages).toEqual(["ok-1", "ok-2"]);
    expect(bufferStore.hasGate(bufferKey)).toBe(false);
    expect(bufferStore.bufferLength(bufferKey)).toBe(0);
  });

  test("requeues drained messages when gate token changes during run", async () => {
    const tempDir = makeTempDir();
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
    const adapter = new MemoryAdapter();
    const activityIndex = new MemoryActivityIndex();
    const bufferStore = new MemorySessionBuffer({ gateTtlSeconds: 3600 });
    const launcher = new OpencodeLauncher();

    const jobData: SessionJobData = {
      botId: "qq-123",
      groupId: "group-1",
      sessionId: "user-1-0",
      userId: "user-1",
      key: 0,
      gateToken: "gate-token",
    };
    const bufferKey: SessionBufferKey = {
      botId: jobData.botId,
      groupId: jobData.groupId,
      sessionId: jobData.sessionId,
    };

    const first: SessionEvent = {
      type: "message",
      platform: "qq",
      selfId: "123",
      userId: jobData.userId,
      guildId: jobData.groupId,
      channelId: jobData.groupId,
      messageId: "msg-1",
      content: "hello",
      elements: [{ type: "text", text: "hello" }],
      timestamp: Date.now(),
      extras: {},
    };
    const second: SessionEvent = {
      ...first,
      messageId: "msg-2",
      content: "second",
      elements: [{ type: "text", text: "second" }],
    };

    const acquired = await bufferStore.appendAndRequestJob(
      bufferKey,
      first,
      jobData.gateToken,
    );
    expect(acquired).toBe(jobData.gateToken);

    const runner: OpencodeRunner = {
      async run(): Promise<OpencodeRunResult> {
        await bufferStore.releaseGate(bufferKey, jobData.gateToken);
        await bufferStore.append(bufferKey, second);
        await bufferStore.claimGate(bufferKey, "new-gate-token");
        return { output: "stale-output" };
      },
    };

    const processor = new SessionProcessor({
      logger,
      adapter,
      groupRepository,
      sessionRepository,
      historyStore,
      launcher,
      runner,
      activityIndex,
      bufferStore,
      limits: { historyEntries: 10, historyBytes: 10_000 },
    });

    try {
      await processor.process({ id: "job-1", data: jobData }, jobData);
    } finally {
      await processor.close();
      rmSync(tempDir, { recursive: true, force: true });
    }

    expect(adapter.messages).toEqual([]);
    const pending = await bufferStore.drain(bufferKey);
    expect(pending.map((entry) => entry.messageId)).toEqual(["msg-1", "msg-2"]);
    const history = await historyStore.readHistory({
      botAccountId: "qq:123",
      userId: jobData.userId,
    });
    expect(history).toEqual([]);
  });
});
