import { describe, expect, test } from "bun:test";
import pino from "pino";

import { resetConfig } from "../../config";
import { startHttpServer } from "../server";

describe("HTTP server auth", () => {
  test("does not expose management endpoints without API_TOKEN", async () => {
    const prevToken = process.env.API_TOKEN;
    try {
      delete process.env.API_TOKEN;
      resetConfig();

      const logger = pino({ level: "silent" });
      const server = await startHttpServer({
        logger,
        port: 0,
        onReloadGroup: async () => true,
      });
      try {
        const health = await fetch(new URL("/health", server.url));
        expect(health.status).toBe(200);

        const reload = await fetch(
          new URL("/api/v1/groups/group-1/reload", server.url),
          { method: "POST" },
        );
        expect(reload.status).toBe(404);
      } finally {
        server.stop();
      }
    } finally {
      if (prevToken === undefined) {
        delete process.env.API_TOKEN;
      } else {
        process.env.API_TOKEN = prevToken;
      }
      resetConfig();
    }
  });

  test("requires API_TOKEN for group reload", async () => {
    const prevToken = process.env.API_TOKEN;
    try {
      process.env.API_TOKEN = "secret-token";
      resetConfig();

      const logger = pino({ level: "silent" });
      const server = await startHttpServer({
        logger,
        port: 0,
        onReloadGroup: async (groupId) => groupId === "group-1",
      });
      try {
        const missingAuth = await fetch(
          new URL("/api/v1/groups/group-1/reload", server.url),
          { method: "POST" },
        );
        expect(missingAuth.status).toBe(401);

        const badAuth = await fetch(
          new URL("/api/v1/groups/group-1/reload", server.url),
          {
            method: "POST",
            headers: { Authorization: "Bearer wrong" },
          },
        );
        expect(badAuth.status).toBe(401);

        const ok = await fetch(
          new URL("/api/v1/groups/group-1/reload", server.url),
          {
            method: "POST",
            headers: { Authorization: "Bearer secret-token" },
          },
        );
        expect(ok.status).toBe(200);
        await expect(ok.json()).resolves.toEqual({
          status: "ok",
          groupId: "group-1",
        });
      } finally {
        server.stop();
      }
    } finally {
      if (prevToken === undefined) {
        delete process.env.API_TOKEN;
      } else {
        process.env.API_TOKEN = prevToken;
      }
      resetConfig();
    }
  });
});
