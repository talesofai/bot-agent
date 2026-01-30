import { getConfig } from "../config";
import { logger } from "../logger";
import { shutdownOtel, startOtel } from "../otel";
import {
  handleHttpRequest,
  type HttpRequestHandlerContext,
} from "../http/server";
import { resolveDataRoot } from "../utils/data-root";
import { createGracefulShutdown } from "../utils/graceful-shutdown";

const config = getConfig();

async function main(): Promise<void> {
  try {
    startOtel({ defaultServiceName: "opencode-bot-agent-wiki" });
  } catch (err) {
    logger.warn({ err }, "Failed to start OpenTelemetry");
  }

  const startedAt = Date.now();
  const version =
    process.env.APP_VERSION ?? process.env.npm_package_version ?? "unknown";
  const dataRoot = resolveDataRoot(config);

  const context: HttpRequestHandlerContext = {
    logger,
    startedAt,
    version,
    apiToken: null,
    dataRoot,
  };

  const server = Bun.serve({
    port: config.HTTP_PORT,
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname !== "/health" && !url.pathname.startsWith("/wiki")) {
        url.pathname = "/wiki" + (url.pathname === "/" ? "" : url.pathname);
      }
      const rewritten = new Request(url.toString(), {
        method: req.method,
        headers: req.headers,
      });
      return handleHttpRequest(rewritten, context);
    },
  });

  logger.info({ port: server.port, dataRoot }, "Wiki server started");

  const shutdownController = createGracefulShutdown({
    logger,
    name: "wiki-server",
    onShutdown: async () => {
      try {
        server.stop();
      } finally {
        await shutdownOtel().catch((err) => {
          logger.warn({ err }, "Failed to shutdown OpenTelemetry");
        });
      }
    },
  });
  shutdownController.installSignalHandlers();
}

await main();
