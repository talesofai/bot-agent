import pino from "pino";

import { getConfig } from "./config";
import { feishuLogJson } from "./feishu/webhook";

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
      hooks: {
        logMethod(args, method, level) {
          try {
            if (typeof level === "number" && level >= 40) {
              const bindings =
                typeof (this as { bindings?: unknown }).bindings === "function"
                  ? (
                      this as { bindings: () => Record<string, unknown> }
                    ).bindings()
                  : {};

              const [first, second] = args as unknown[];
              const firstIsError =
                (first as unknown as object) instanceof Error;
              const objectArg =
                first && typeof first === "object" && !firstIsError
                  ? (first as Record<string, unknown>)
                  : undefined;
              const msg =
                typeof first === "string"
                  ? first
                  : typeof second === "string"
                    ? second
                    : "";

              const errCandidate = objectArg?.err;
              const err = firstIsError
                ? (first as Error)
                : (errCandidate as unknown as object) instanceof Error
                  ? (errCandidate as Error)
                  : undefined;

              feishuLogJson({
                event: level >= 50 ? "log.error" : "log.warn",
                msg,
                sourceEvent:
                  typeof objectArg?.event === "string"
                    ? objectArg.event
                    : undefined,
                phase:
                  (bindings["phase"] as string | undefined) ??
                  (objectArg?.phase as string | undefined),
                step:
                  (bindings["step"] as string | undefined) ??
                  (objectArg?.step as string | undefined),
                component:
                  (bindings["component"] as string | undefined) ??
                  (objectArg?.component as string | undefined),
                ok:
                  (bindings["ok"] as boolean | undefined) ??
                  (objectArg?.ok as boolean | undefined),
                durationMs:
                  (bindings["durationMs"] as number | undefined) ??
                  (objectArg?.durationMs as number | undefined),
                traceId:
                  (bindings["traceId"] as string | undefined) ??
                  (objectArg?.traceId as string | undefined),
                jobId:
                  (bindings["jobId"] as string | undefined) ??
                  (objectArg?.jobId as string | undefined),
                groupId:
                  (bindings["groupId"] as string | undefined) ??
                  (objectArg?.groupId as string | undefined),
                sessionId:
                  (bindings["sessionId"] as string | undefined) ??
                  (objectArg?.sessionId as string | undefined),
                channelId:
                  (bindings["channelId"] as string | undefined) ??
                  (objectArg?.channelId as string | undefined),
                userId:
                  (bindings["userId"] as string | undefined) ??
                  (objectArg?.userId as string | undefined),
                errName: err?.name,
                errMessage: err?.message,
              });
            }
          } catch {
            // Never block or break logging on Feishu failures.
          }
          return method.apply(this, args);
        },
      },
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
