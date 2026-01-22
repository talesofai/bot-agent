import type { Logger } from "pino";

export interface GracefulShutdownOptions {
  logger: Logger;
  name: string;
  timeoutMs?: number;
  onShutdown: () => Promise<void>;
}

export interface GracefulShutdownController {
  installSignalHandlers: () => void;
  shutdown: (input?: { exitCode?: number; reason?: unknown }) => Promise<void>;
}

export function createGracefulShutdown(
  options: GracefulShutdownOptions,
): GracefulShutdownController {
  const timeoutMs = options.timeoutMs ?? 15_000;
  let shutdownPromise: Promise<void> | null = null;

  const shutdown = async (input?: {
    exitCode?: number;
    reason?: unknown;
  }): Promise<void> => {
    if (shutdownPromise) {
      return shutdownPromise;
    }

    const exitCode = input?.exitCode ?? 0;
    if (process.exitCode === undefined) {
      process.exitCode = exitCode;
    }

    shutdownPromise = (async () => {
      options.logger.info(
        { exitCode, reason: input?.reason },
        `${options.name} shutting down...`,
      );

      const timer = setTimeout(() => {
        options.logger.error(
          { exitCode, timeoutMs },
          `${options.name} shutdown timed out; forcing exit`,
        );
        process.exit(exitCode);
      }, timeoutMs);
      timer.unref?.();

      try {
        await options.onShutdown();
      } catch (err) {
        options.logger.error({ err }, `${options.name} shutdown failed`);
        if (process.exitCode === undefined || process.exitCode === 0) {
          process.exitCode = 1;
        }
      } finally {
        clearTimeout(timer);
      }
    })();

    return shutdownPromise;
  };

  const installSignalHandlers = (): void => {
    const handler = (signal: NodeJS.Signals) => {
      void shutdown({ exitCode: 0, reason: signal });
    };
    process.on("SIGINT", handler);
    process.on("SIGTERM", handler);
  };

  return { installSignalHandlers, shutdown };
}
