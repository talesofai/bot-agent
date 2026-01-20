import { randomBytes } from "node:crypto";
import type { Logger } from "pino";
import { getConfig } from "./config";

const TRACE_ID_RE = /^[a-f0-9]{32}$/;

export type TelemetryPhase = "adapter" | "worker";

export interface TelemetrySpanInput {
  traceId: string;
  phase: TelemetryPhase;
  step: string;
  component: string;
  message?: {
    platform?: string;
    botId?: string;
    groupId?: string;
    userId?: string;
    channelId?: string;
    messageId?: string;
    key?: number;
    sessionId?: string;
  };
  job?: {
    id?: string;
  };
  attrs?: Record<string, unknown>;
}

export function createTraceId(): string {
  return randomBytes(16).toString("hex");
}

export function normalizeTraceId(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim().toLowerCase();
  if (!TRACE_ID_RE.test(normalized)) {
    return null;
  }
  return normalized;
}

export function resolveTraceId(value: unknown): string {
  return normalizeTraceId(value) ?? createTraceId();
}

export function getTraceIdFromExtras(extras: unknown): string | null {
  if (!isRecord(extras)) {
    return null;
  }
  const candidate = extras.traceId;
  return normalizeTraceId(candidate);
}

export function setTraceIdOnExtras(extras: unknown, traceId: string): unknown {
  if (!isRecord(extras)) {
    return { traceId };
  }
  if (extras.traceId === traceId) {
    return extras;
  }
  return { ...extras, traceId };
}

export function shouldEmitTelemetry(traceId: string): boolean {
  const config = getConfig();
  if (!config.TELEMETRY_ENABLED) {
    return false;
  }
  const sampleRate = config.TELEMETRY_SAMPLE_RATE;
  if (sampleRate >= 1) {
    return true;
  }
  if (sampleRate <= 0) {
    return false;
  }
  const normalized = traceId.trim().toLowerCase();
  if (!TRACE_ID_RE.test(normalized)) {
    return false;
  }
  const bucket = Number.parseInt(normalized.slice(-2), 16) / 255;
  return bucket < sampleRate;
}

export async function withTelemetrySpan<T>(
  logger: Logger,
  input: TelemetrySpanInput,
  fn: () => Promise<T>,
): Promise<T> {
  if (!shouldEmitTelemetry(input.traceId)) {
    return fn();
  }

  const startedAt = Date.now();
  const startedHr = process.hrtime.bigint();
  try {
    const result = await fn();
    const durationMs = Number(process.hrtime.bigint() - startedHr) / 1e6;
    logger.info(
      {
        event: "telemetry.span",
        traceId: input.traceId,
        phase: input.phase,
        step: input.step,
        component: input.component,
        startedAt,
        durationMs,
        ok: true,
        ...flattenTelemetryContext(input),
      },
      "telemetry.span",
    );
    return result;
  } catch (err) {
    const durationMs = Number(process.hrtime.bigint() - startedHr) / 1e6;
    const error = normalizeError(err);
    logger.warn(
      {
        event: "telemetry.span",
        traceId: input.traceId,
        phase: input.phase,
        step: input.step,
        component: input.component,
        startedAt,
        durationMs,
        ok: false,
        errName: error.name,
        errMessage: error.message,
        ...flattenTelemetryContext(input),
      },
      "telemetry.span",
    );
    throw err;
  }
}

function flattenTelemetryContext(
  input: TelemetrySpanInput,
): Record<string, unknown> {
  const attrs: Record<string, unknown> = { ...(input.attrs ?? {}) };
  const message = input.message;
  if (message) {
    if (message.platform) attrs.platform = message.platform;
    if (message.botId) attrs.botId = message.botId;
    if (message.groupId) attrs.groupId = message.groupId;
    if (message.userId) attrs.userId = message.userId;
    if (message.channelId) attrs.channelId = message.channelId;
    if (message.messageId) attrs.messageId = message.messageId;
    if (typeof message.key === "number") attrs.key = message.key;
    if (message.sessionId) attrs.sessionId = message.sessionId;
  }
  const job = input.job;
  if (job?.id) {
    attrs.jobId = job.id;
  }
  return attrs;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeError(err: unknown): { name: string; message: string } {
  if (err instanceof Error) {
    return { name: err.name, message: err.message };
  }
  return { name: "Error", message: String(err) };
}
