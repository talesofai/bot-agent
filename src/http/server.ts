import type { Logger } from "pino";

import { getConfig } from "../config";

export interface HttpServerOptions {
  logger: Logger;
  port?: number;
  onReloadGroup?: (groupId: string) => Promise<boolean>;
}

export type HttpServer = Server;

let cachedVersion: string | null = null;

export async function startHttpServer(
  options: HttpServerOptions,
): Promise<HttpServer> {
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
      const reloadMatch = url.pathname.match(
        /^\/api\/v1\/groups\/([^/]+)\/reload$/,
      );
      if (reloadMatch) {
        if (req.method !== "POST") {
          return new Response("Method Not Allowed", {
            status: 405,
            headers: { Allow: "POST" },
          });
        }
        if (!options.onReloadGroup) {
          return new Response("Not Found", { status: 404 });
        }
        const groupId = decodeURIComponent(reloadMatch[1]);
        return options
          .onReloadGroup(groupId)
          .then((reloaded) => {
            if (!reloaded) {
              return new Response("Not Found", { status: 404 });
            }
            return Response.json({ status: "ok", groupId });
          })
          .catch((err) => {
            options.logger.error({ err, groupId }, "Failed to reload group");
            return new Response("Reload failed", { status: 500 });
          });
      }
      return new Response("Not Found", { status: 404 });
    },
  });

  options.logger.info({ port }, "HTTP server started");
  return server;
}

async function resolveVersion(): Promise<string> {
  if (cachedVersion) {
    return cachedVersion;
  }
  const envVersion = process.env.APP_VERSION ?? process.env.npm_package_version;
  cachedVersion = envVersion ?? "unknown";
  return cachedVersion;
}

function formatUptime(durationMs: number): string {
  const totalSeconds = Math.floor(durationMs / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return `${hours}h${minutes}m${seconds}s`;
}
