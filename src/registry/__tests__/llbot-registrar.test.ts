import { describe, expect, mock, test } from "bun:test";
import type { Logger } from "pino";

import { LlbotRegistrar } from "../llbot-registrar";

describe("LlbotRegistrar", () => {
  const createMockLogger = (): Logger => {
    const mockLogger = {
      debug: mock(() => {}),
      info: mock(() => {}),
      warn: mock(() => {}),
      error: mock(() => {}),
      child: mock(() => mockLogger),
    };
    return mockLogger as unknown as Logger;
  };

  test("rejects refresh interval greater than or equal to ttl", () => {
    expect(
      () =>
        new LlbotRegistrar({
          redisUrl: "redis://localhost:6379",
          prefix: "llbot:registry",
          botId: "bot-1",
          wsUrl: "ws://localhost:3000",
          platform: "qq",
          ttlSec: 10,
          refreshIntervalSec: 10,
        }),
    ).toThrow("llbot registrar refresh interval must be less than ttl");
  });

  test("writes registry entry with ttl", async () => {
    const setCalls: unknown[][] = [];
    const saddCalls: unknown[][] = [];
    const mockRedis = {
      set: mock(async (...args: unknown[]) => {
        setCalls.push(args);
      }),
      sadd: mock(async (...args: unknown[]) => {
        saddCalls.push(args);
      }),
      quit: mock(async () => {}),
    };
    const logger = createMockLogger();
    const registrar = new LlbotRegistrar({
      redisUrl: "redis://localhost:6379",
      prefix: "llbot:registry",
      botId: "bot-1",
      wsUrl: "ws://localhost:3000",
      platform: "qq",
      ttlSec: 15,
      refreshIntervalSec: 5,
      redis: mockRedis,
      logger,
    });

    await registrar.start();
    await registrar.stop();

    expect(setCalls.length).toBe(1);
    const [key, payload, mode, ttl] = setCalls[0];
    expect(key).toBe("llbot:registry:bot-1");
    expect(mode).toBe("EX");
    expect(ttl).toBe(15);
    const parsed = JSON.parse(payload as string);
    expect(parsed).toMatchObject({
      wsUrl: "ws://localhost:3000",
      platform: "qq",
    });
    expect(typeof parsed.lastSeenAt).toBe("string");
    expect(saddCalls).toEqual([
      ["llbot:registry:index", "llbot:registry:bot-1"],
    ]);
  });

  test("writes registry entry without ttl when ttl is zero", async () => {
    const setCalls: unknown[][] = [];
    const saddCalls: unknown[][] = [];
    const mockRedis = {
      set: mock(async (...args: unknown[]) => {
        setCalls.push(args);
      }),
      sadd: mock(async (...args: unknown[]) => {
        saddCalls.push(args);
      }),
      quit: mock(async () => {}),
    };
    const registrar = new LlbotRegistrar({
      redisUrl: "redis://localhost:6379",
      prefix: "llbot:registry",
      botId: "bot-2",
      wsUrl: "ws://localhost:3001",
      platform: "discord",
      ttlSec: 0,
      refreshIntervalSec: 5,
      redis: mockRedis,
      logger: createMockLogger(),
    });

    await registrar.start();
    await registrar.stop();

    expect(setCalls.length).toBe(1);
    expect(setCalls[0].length).toBe(2);
    expect(saddCalls).toEqual([
      ["llbot:registry:index", "llbot:registry:bot-2"],
    ]);
  });

  test("logs refresh errors and keeps running", async () => {
    const mockRedis = {
      set: mock(async () => {
        throw new Error("redis down");
      }),
      sadd: mock(async () => {}),
      quit: mock(async () => {}),
    };
    const logger = createMockLogger();
    const registrar = new LlbotRegistrar({
      redisUrl: "redis://localhost:6379",
      prefix: "llbot:registry",
      botId: "bot-3",
      wsUrl: "ws://localhost:3002",
      platform: "qq",
      ttlSec: 15,
      refreshIntervalSec: 5,
      redis: mockRedis,
      logger,
    });

    await registrar.start();
    await registrar.stop();

    expect(logger.error).toHaveBeenCalledTimes(1);
  });
});
