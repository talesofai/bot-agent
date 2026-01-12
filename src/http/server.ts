import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import type { Logger } from "pino";

import { getConfig } from "../config";

export interface HttpServerOptions {
  logger: Logger;
  port?: number;
}

export async function startHttpServer(
  options: HttpServerOptions,
): Promise<Server> {
  const config = getConfig();
  const startedAt = Date.now();
  const version = await resolveVersion();
  const port = options.port ?? config.HTTP_PORT;

  const server = Bun.serve({
    port,
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/health") {
        return Response.json({
          status: "ok",
          version,
          uptime: formatUptime(Date.now() - startedAt),
        });
      }
      return new Response("Not Found", { status: 404 });
    },
  });

  options.logger.info({ port }, "HTTP server started");
  return server;
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
