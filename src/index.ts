import { config } from "./config.js";
import { logger } from "./logger.js";

logger.info(
  {
    env: config.NODE_ENV ?? "development",
    bunVersion: Bun.version,
  },
  "Bot agent starting",
);
