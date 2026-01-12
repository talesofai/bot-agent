import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fastify, { type FastifyInstance } from "fastify";
import type { Logger } from "pino";

import { getConfig } from "../config";

export interface HttpServerOptions {
  logger: Logger;
  port?: number;
}

export async function startHttpServer(
  options: HttpServerOptions,
): Promise<FastifyInstance> {
  const config = getConfig();
  const app = fastify({ logger: options.logger });
  const startedAt = Date.now();
  const version = await resolveVersion();
  const port = options.port ?? config.HTTP_PORT;

  app.get("/health", async () => ({
    status: "ok",
    version,
    uptime: formatUptime(Date.now() - startedAt),
  }));

  await app.listen({ port, host: "0.0.0.0" });
  return app;
}

async function resolveVersion(): Promise<string> {
  try {
    const moduleDir = path.dirname(fileURLToPath(import.meta.url));
    const packagePath = path.resolve(moduleDir, "..", "..", "package.json");
    const raw = await readFile(packagePath, "utf-8");
    const parsed = JSON.parse(raw) as { version?: string };
    return parsed.version ?? "unknown";
  } catch {
    return "unknown";
  }
}

function formatUptime(durationMs: number): string {
  const totalSeconds = Math.floor(durationMs / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return `${hours}h${minutes}m${seconds}s`;
}
