import { describe, expect, test } from "bun:test";

import { LlbotRegistrar } from "../llbot-registrar";

describe("LlbotRegistrar", () => {
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
});
