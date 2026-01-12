import pino from "pino";

import { getConfig } from "./config";

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

export const logger = pino(
  {
    level: config.LOG_LEVEL,
    base: undefined,
  },
  transport,
);
