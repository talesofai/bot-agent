import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";

import { resetConfig } from "../../config";
import type { SessionEvent } from "../../types/platform";
import type {
  Bot,
  MessageHandler,
  PlatformAdapter,
} from "../../types/platform";
import type { BullmqSessionQueue } from "../../queue";
import type { SessionJobData } from "../../queue";
import type { SessionBuffer, SessionBufferKey } from "../../session/buffer";
import { GroupStore } from "../../store";
import { SessionRepository } from "../../session";
import type { WorldStore } from "../../world/store";
import { EchoTracker } from "../echo";
import { MessageDispatcher } from "../message-dispatcher";
import { resolveDispatchGroupId } from "../message-dispatcher";

const baseMessage: SessionEvent = {
  type: "message",
  platform: "qq",
  selfId: "bot-1",
  userId: "user-1",
  guildId: "guild-1",
  channelId: "channel-1",
  messageId: "msg-1",
  content: "hello",
  elements: [{ type: "text", text: "hello" }],
  timestamp: Date.now(),
  extras: {},
};

describe("resolveDispatchGroupId", () => {
  test("uses guildId by default for guild messages", () => {
    const groupId = resolveDispatchGroupId(baseMessage);
    expect(groupId).toBe("guild-1");
  });

  test("returns forceGroupId when provided", () => {
    const groupId = resolveDispatchGroupId(baseMessage, "forced-group");
    expect(groupId).toBe("forced-group");
  });

  test("returns 0 for direct messages", () => {
    const message: SessionEvent = {
      ...baseMessage,
      guildId: undefined,
      channelId: "dm-1",
    };
    const groupId = resolveDispatchGroupId(message);
    expect(groupId).toBe("0");
  });
});

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "message-dispatcher-test-"));
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

class NoopSessionBuffer implements SessionBuffer {
  getGateTtlSeconds(): number {
    return 60;
  }

  async append(_key: SessionBufferKey, _message: SessionEvent): Promise<void> {}

  async requeueFront(): Promise<void> {}

  async appendAndRequestJob(): Promise<string | null> {
    return null;
  }

  async drain(): Promise<SessionEvent[]> {
    return [];
  }

  async claimGate(): Promise<boolean> {
    return true;
  }

  async refreshGate(): Promise<boolean> {
    return true;
  }

  async tryReleaseGate(): Promise<boolean> {
    return true;
  }

  async releaseGate(): Promise<boolean> {
    return true;
  }

  async close(): Promise<void> {}
}

class CapturingSessionBuffer implements SessionBuffer {
  lastKey: SessionBufferKey | null = null;
  lastMessage: SessionEvent | null = null;

  getGateTtlSeconds(): number {
    return 60;
  }

  async append(_key: SessionBufferKey, _message: SessionEvent): Promise<void> {}

  async requeueFront(): Promise<void> {}

  async appendAndRequestJob(
    key: SessionBufferKey,
    message: SessionEvent,
    token: string,
  ): Promise<string | null> {
    this.lastKey = key;
    this.lastMessage = message;
    return token;
  }

  async drain(): Promise<SessionEvent[]> {
    return [];
  }

  async claimGate(): Promise<boolean> {
    return true;
  }

  async refreshGate(): Promise<boolean> {
    return true;
  }

  async tryReleaseGate(): Promise<boolean> {
    return true;
  }

  async releaseGate(): Promise<boolean> {
    return true;
  }

  async close(): Promise<void> {}
}

class CapturingSessionQueue {
  jobs: SessionJobData[] = [];

  async enqueue(
    jobData: SessionJobData,
  ): Promise<{ id: string; data: SessionJobData }> {
    this.jobs.push(jobData);
    return { id: "job-1", data: jobData };
  }

  async close(): Promise<void> {}
}

class MemoryEchoStore {
  private data = new Map<string, string>();

  async get(key: string): Promise<string | null> {
    return this.data.get(key) ?? null;
  }

  async set(key: string, value: string): Promise<void> {
    this.data.set(key, value);
  }

  async del(key: string): Promise<void> {
    this.data.delete(key);
  }

  async close(): Promise<void> {}
}

describe("MessageDispatcher management commands", () => {
  test("allows Discord guild owner to reset all even when adminUsers is empty", async () => {
    const tempDir = makeTempDir();
    const logger = pino({ level: "silent" });
    const adapter = new MemoryAdapter();
    const groupStore = new GroupStore({ dataDir: tempDir, logger });
    await groupStore.init();
    const sessionRepository = new SessionRepository({
      dataDir: tempDir,
      logger,
    });

    const dispatcher = new MessageDispatcher({
      adapter,
      groupStore,
      routerStore: null,
      sessionRepository,
      sessionQueue: {} as unknown as BullmqSessionQueue,
      bufferStore: new NoopSessionBuffer(),
      echoTracker: new EchoTracker({ store: new MemoryEchoStore() }),
      logger,
    });

    try {
      await dispatcher.dispatch({
        type: "message",
        platform: "discord",
        selfId: "123",
        userId: "999",
        guildId: "guild1",
        channelId: "channel1",
        messageId: "msg1",
        content: "/reset all",
        elements: [
          { type: "mention", userId: "123" },
          { type: "text", text: "/reset all" },
        ],
        timestamp: Date.now(),
        extras: { isGuildOwner: true },
      });

      expect(adapter.messages).toEqual(["当前没有可重置的用户会话。"]);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("rejects reset all when caller is not an admin", async () => {
    const tempDir = makeTempDir();
    const logger = pino({ level: "silent" });
    const adapter = new MemoryAdapter();
    const groupStore = new GroupStore({ dataDir: tempDir, logger });
    await groupStore.init();
    const sessionRepository = new SessionRepository({
      dataDir: tempDir,
      logger,
    });

    const dispatcher = new MessageDispatcher({
      adapter,
      groupStore,
      routerStore: null,
      sessionRepository,
      sessionQueue: {} as unknown as BullmqSessionQueue,
      bufferStore: new NoopSessionBuffer(),
      echoTracker: new EchoTracker({ store: new MemoryEchoStore() }),
      logger,
    });

    try {
      await dispatcher.dispatch({
        type: "message",
        platform: "discord",
        selfId: "123",
        userId: "999",
        guildId: "guild1",
        channelId: "channel1",
        messageId: "msg1",
        content: "/reset all",
        elements: [
          { type: "mention", userId: "123" },
          { type: "text", text: "/reset all" },
        ],
        timestamp: Date.now(),
        extras: {},
      });

      expect(adapter.messages).toEqual(["无权限：仅管理员可重置全群会话。"]);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("allows /model with slashed model id when configured in OPENCODE_MODELS", async () => {
    const tempDir = makeTempDir();
    const logger = pino({ level: "silent" });
    const adapter = new MemoryAdapter();
    const groupStore = new GroupStore({ dataDir: tempDir, logger });
    await groupStore.init();
    const sessionRepository = new SessionRepository({
      dataDir: tempDir,
      logger,
    });

    const prevModels = process.env.OPENCODE_MODELS;
    process.env.OPENCODE_MODELS = "vol/glm-4.7,gpt-5.2";
    resetConfig();

    const dispatcher = new MessageDispatcher({
      adapter,
      groupStore,
      routerStore: null,
      sessionRepository,
      sessionQueue: {} as unknown as BullmqSessionQueue,
      bufferStore: new NoopSessionBuffer(),
      echoTracker: new EchoTracker({ store: new MemoryEchoStore() }),
      logger,
    });

    try {
      await dispatcher.dispatch({
        type: "message",
        platform: "discord",
        selfId: "123",
        userId: "999",
        guildId: "guild1",
        channelId: "channel1",
        messageId: "msg1",
        content: "/model vol/glm-4.7",
        elements: [
          { type: "mention", userId: "123" },
          { type: "text", text: "/model vol/glm-4.7" },
        ],
        timestamp: Date.now(),
        extras: { isGuildOwner: true },
      });

      expect(adapter.messages).toEqual([
        "已切换模型：vol/glm-4.7（实际使用：vol/glm-4.7）",
      ]);
    } finally {
      if (prevModels === undefined) {
        delete process.env.OPENCODE_MODELS;
      } else {
        process.env.OPENCODE_MODELS = prevModels;
      }
      resetConfig();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

describe("MessageDispatcher telemetry propagation", () => {
  test("enqueues jobs with traceId and timestamps", async () => {
    const tempDir = makeTempDir();
    const logger = pino({ level: "silent" });
    const adapter = new MemoryAdapter();
    const groupStore = new GroupStore({ dataDir: tempDir, logger });
    await groupStore.init();
    const sessionRepository = new SessionRepository({
      dataDir: tempDir,
      logger,
    });
    const bufferStore = new CapturingSessionBuffer();
    const sessionQueue = new CapturingSessionQueue();

    const dispatcher = new MessageDispatcher({
      adapter,
      groupStore,
      routerStore: null,
      sessionRepository,
      sessionQueue: sessionQueue as unknown as BullmqSessionQueue,
      bufferStore,
      echoTracker: new EchoTracker({ store: new MemoryEchoStore() }),
      logger,
    });

    try {
      const before = Date.now();
      await dispatcher.dispatch({
        type: "message",
        platform: "discord",
        selfId: "123",
        userId: "999",
        guildId: "guild1",
        channelId: "channel1",
        messageId: "msg1",
        content: "hello",
        elements: [
          { type: "mention", userId: "123" },
          { type: "text", text: "hello" },
        ],
        timestamp: before,
        extras: {},
      });
      const after = Date.now();

      expect(sessionQueue.jobs).toHaveLength(1);
      const jobData = sessionQueue.jobs[0];
      expect(jobData.traceId).toMatch(/^[a-f0-9]{32}$/);
      expect(jobData.traceStartedAt).toBeGreaterThanOrEqual(before);
      expect(jobData.traceStartedAt).toBeLessThanOrEqual(after);
      expect(jobData.enqueuedAt).toBeGreaterThanOrEqual(before);
      expect(jobData.enqueuedAt).toBeLessThanOrEqual(after);

      expect(bufferStore.lastMessage).toBeTruthy();
      const extras = (bufferStore.lastMessage as SessionEvent).extras as {
        traceId?: string;
      };
      expect(extras.traceId).toBe(jobData.traceId);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

describe("MessageDispatcher world routing", () => {
  test("rewrites groupId when channel is mapped to a world", async () => {
    const tempDir = makeTempDir();
    const logger = pino({ level: "silent" });
    const adapter = new MemoryAdapter();
    const groupStore = new GroupStore({ dataDir: tempDir, logger });
    await groupStore.init();
    const sessionRepository = new SessionRepository({
      dataDir: tempDir,
      logger,
    });
    const bufferStore = new CapturingSessionBuffer();
    const sessionQueue = new CapturingSessionQueue();

    const dispatcher = new MessageDispatcher({
      adapter,
      groupStore,
      routerStore: null,
      sessionRepository,
      sessionQueue: sessionQueue as unknown as BullmqSessionQueue,
      bufferStore,
      echoTracker: new EchoTracker({ store: new MemoryEchoStore() }),
      worldStore: {
        getWorldIdByChannel: async () => 1,
      } as unknown as WorldStore,
      logger,
    });

    try {
      await dispatcher.dispatch({
        type: "message",
        platform: "discord",
        selfId: "123",
        userId: "999",
        guildId: "guild1",
        channelId: "channel-world",
        messageId: "msg1",
        content: "hello",
        elements: [
          { type: "mention", userId: "123" },
          { type: "text", text: "hello" },
        ],
        timestamp: Date.now(),
        extras: {},
      });

      expect(sessionQueue.jobs).toHaveLength(1);
      expect(sessionQueue.jobs[0]?.groupId).toBe("world_1");
      expect(bufferStore.lastKey?.groupId).toBe("world_1");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("does not enqueue when message is not a trigger outside world channels", async () => {
    const tempDir = makeTempDir();
    const logger = pino({ level: "silent" });
    const adapter = new MemoryAdapter();
    const groupStore = new GroupStore({ dataDir: tempDir, logger });
    await groupStore.init();
    const sessionRepository = new SessionRepository({
      dataDir: tempDir,
      logger,
    });
    const bufferStore = new CapturingSessionBuffer();
    const sessionQueue = new CapturingSessionQueue();

    const dispatcher = new MessageDispatcher({
      adapter,
      groupStore,
      routerStore: null,
      sessionRepository,
      sessionQueue: sessionQueue as unknown as BullmqSessionQueue,
      bufferStore,
      echoTracker: new EchoTracker({ store: new MemoryEchoStore() }),
      worldStore: {
        getWorldIdByChannel: async () => null,
      } as unknown as WorldStore,
      logger,
    });

    try {
      await dispatcher.dispatch({
        type: "message",
        platform: "discord",
        selfId: "123",
        userId: "999",
        guildId: "guild1",
        channelId: "channel1",
        messageId: "msg1",
        content: "hello",
        elements: [{ type: "text", text: "hello" }],
        timestamp: Date.now(),
        extras: {},
      });

      expect(sessionQueue.jobs).toHaveLength(0);
      expect(bufferStore.lastKey).toBeNull();
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
