import pino from "pino";

import { getConfig } from "./config";

let loggerInstance: pino.Logger | null = null;

function buildLogger(): pino.Logger {
  const config = getConfig();
  const logFormat = config.LOG_FORMAT?.toLowerCase() ?? "json";
  const transport =
    logFormat === "pretty"
      ? pino.transport({
          target: "pino-pretty",
          options: {
            colorize: true,
            translateTime: "SYS:standard",
            ignore: "pid,hostname",
          },
        })
      : undefined;

  return pino(
    {
      level: config.LOG_LEVEL,
      base: undefined,
    },
    transport,
  );
}

export function getLogger(): pino.Logger {
  if (!loggerInstance) {
    loggerInstance = buildLogger();
  }
  return loggerInstance;
}

export function resetLogger(): void {
  loggerInstance = null;
}

export const logger = new Proxy({} as pino.Logger, {
  get(_target, prop, receiver) {
    const instance = getLogger();
    const value = Reflect.get(instance, prop, receiver);
    if (typeof value === "function") {
      return value.bind(instance);
    }
    return value;
  },
});
