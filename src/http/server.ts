import type { Logger } from "pino";

import { getConfig } from "../config";
import { isSafePathSegment } from "../utils/path";

export interface HttpServerOptions {
  logger: Logger;
  port?: number;
  onReloadGroup?: (groupId: string) => Promise<boolean>;
}

export type HttpServer = ReturnType<typeof Bun.serve>;

export interface HttpRequestHandlerContext {
  logger: Logger;
  startedAt: number;
  version: string;
  apiToken: string | null;
  onReloadGroup?: (groupId: string) => Promise<boolean>;
}

let cachedVersion: string | null = null;

export async function startHttpServer(
  options: HttpServerOptions,
): Promise<HttpServer> {
  const config = getConfig();
  const startedAt = Date.now();
  const version = await resolveVersion();
  const port = options.port ?? config.HTTP_PORT;
  const apiToken = config.API_TOKEN?.trim() || null;

  const context: HttpRequestHandlerContext = {
    logger: options.logger,
    startedAt,
    version,
    apiToken,
    onReloadGroup: options.onReloadGroup,
  };

  const server = Bun.serve({
    port,
    fetch(req) {
      return handleHttpRequest(req, context);
    },
  });

  options.logger.info({ port }, "HTTP server started");
  return server;
}

export function handleHttpRequest(
  req: Request,
  context: HttpRequestHandlerContext,
): Response | Promise<Response> {
  const url = new URL(req.url);
  if (url.pathname === "/health") {
    return Response.json({
      status: "ok",
      version: context.version,
      uptime: formatUptime(Date.now() - context.startedAt),
    });
  }

  const reloadMatch = url.pathname.match(
    /^\/api\/v1\/groups\/([^/]+)\/reload$/,
  );
  if (!reloadMatch) {
    return new Response("Not Found", { status: 404 });
  }

  if (!context.onReloadGroup || !context.apiToken) {
    return new Response("Not Found", { status: 404 });
  }

  if (!isAuthorized(req, context.apiToken)) {
    return new Response("Unauthorized", {
      status: 401,
      headers: { "WWW-Authenticate": 'Bearer realm="api"' },
    });
  }

  if (req.method !== "POST") {
    return new Response("Method Not Allowed", {
      status: 405,
      headers: { Allow: "POST" },
    });
  }

  let groupId: string;
  try {
    groupId = decodeURIComponent(reloadMatch[1]);
  } catch {
    return new Response("Invalid groupId", { status: 400 });
  }
  if (!isSafePathSegment(groupId)) {
    return new Response("Invalid groupId", { status: 400 });
  }

  return context
    .onReloadGroup(groupId)
    .then((reloaded) => {
      if (!reloaded) {
        return new Response("Not Found", { status: 404 });
      }
      return Response.json({ status: "ok", groupId });
    })
    .catch((err) => {
      context.logger.error({ err, groupId }, "Failed to reload group");
      return new Response("Reload failed", { status: 500 });
    });
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

function isAuthorized(req: Request, token: string): boolean {
  const bearer = req.headers.get("authorization");
  if (bearer) {
    const parsed = parseBearerToken(bearer);
    if (parsed !== null) {
      return parsed === token;
    }
  }
  const apiHeader = req.headers.get("x-api-token");
  if (apiHeader) {
    return apiHeader === token;
  }
  return false;
}

function parseBearerToken(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed.length < 7) {
    return null;
  }
  if (!trimmed.toLowerCase().startsWith("bearer ")) {
    return null;
  }
  const token = trimmed.slice(7).trim();
  return token ? token : null;
}
