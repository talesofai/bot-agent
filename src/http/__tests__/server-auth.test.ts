import { describe, expect, test } from "bun:test";
import pino from "pino";

import { handleHttpRequest, type HttpRequestHandlerContext } from "../server";

describe("HTTP server auth", () => {
  test("does not expose management endpoints without API_TOKEN", async () => {
    const logger = pino({ level: "silent" });
    const context: HttpRequestHandlerContext = {
      logger,
      startedAt: 0,
      version: "test",
      apiToken: null,
      onReloadGroup: async () => true,
    };

    const health = await handleHttpRequest(
      new Request("http://test/health"),
      context,
    );
    expect(health.status).toBe(200);

    const reload = await handleHttpRequest(
      new Request("http://test/api/v1/groups/group-1/reload", {
        method: "POST",
      }),
      context,
    );
    expect(reload.status).toBe(404);
  });

  test("requires API_TOKEN for group reload", async () => {
    const logger = pino({ level: "silent" });
    const context: HttpRequestHandlerContext = {
      logger,
      startedAt: 0,
      version: "test",
      apiToken: "secret-token",
      onReloadGroup: async (groupId) => groupId === "group-1",
    };

    const missingAuth = await handleHttpRequest(
      new Request("http://test/api/v1/groups/group-1/reload", {
        method: "POST",
      }),
      context,
    );
    expect(missingAuth.status).toBe(401);

    const badAuth = await handleHttpRequest(
      new Request("http://test/api/v1/groups/group-1/reload", {
        method: "POST",
        headers: { Authorization: "Bearer wrong" },
      }),
      context,
    );
    expect(badAuth.status).toBe(401);

    const ok = await handleHttpRequest(
      new Request("http://test/api/v1/groups/group-1/reload", {
        method: "POST",
        headers: { Authorization: "Bearer secret-token" },
      }),
      context,
    );
    expect(ok.status).toBe(200);
    await expect(ok.json()).resolves.toEqual({
      status: "ok",
      groupId: "group-1",
    });
  });
});
