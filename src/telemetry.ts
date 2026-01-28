import { randomBytes } from "node:crypto";
import type { Logger } from "pino";
import {
  context as otelContext,
  ROOT_CONTEXT,
  SpanKind,
  SpanStatusCode,
  TraceFlags,
  trace,
} from "@opentelemetry/api";
import { getConfig } from "./config";
import { getOtelTracer, isOtelStarted } from "./otel";

const TRACE_ID_RE = /^[a-f0-9]{32}$/;

export type TelemetryPhase = "adapter" | "worker";

const SPAN_ID_RE = /^[a-f0-9]{16}$/;

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

export function createSpanId(): string {
  return randomBytes(8).toString("hex");
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

export function normalizeSpanId(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim().toLowerCase();
  if (!SPAN_ID_RE.test(normalized)) {
    return null;
  }
  return normalized;
}

export function resolveSpanId(value: unknown): string {
  return normalizeSpanId(value) ?? createSpanId();
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

export function createTraceparent(input: {
  traceId: string;
  spanId?: string;
  sampled?: boolean;
}): string {
  const traceId = resolveTraceId(input.traceId);
  const spanId = resolveSpanId(input.spanId);
  const traceFlags = input.sampled === false ? "00" : "01";
  return `00-${traceId}-${spanId}-${traceFlags}`;
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
  const otelParentContext = isOtelStarted() ? getOtelParent(input) : null;
  const otelSpan = otelParentContext
    ? startOtelSpan(input, startedAt, otelParentContext)
    : null;
  const otelSpanContext =
    otelSpan && otelParentContext
      ? trace.setSpan(otelParentContext, otelSpan)
      : null;
  try {
    const result = otelSpanContext
      ? await otelContext.with(otelSpanContext, fn)
      : await fn();
    const durationMs = Number(process.hrtime.bigint() - startedHr) / 1e6;
    if (otelSpan) {
      otelSpan.setStatus({ code: SpanStatusCode.OK });
      otelSpan.end();
    }
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
    if (otelSpan) {
      otelSpan.recordException(err as Error);
      otelSpan.setStatus({
        code: SpanStatusCode.ERROR,
        message: error.message,
      });
      otelSpan.end();
    }
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

function getOtelParent(input: TelemetrySpanInput) {
  const active = trace.getSpan(otelContext.active());
  const activeTraceId = active?.spanContext().traceId;
  if (activeTraceId && activeTraceId === input.traceId) {
    return otelContext.active();
  }

  return trace.setSpanContext(ROOT_CONTEXT, {
    traceId: resolveTraceId(input.traceId),
    spanId: createSpanId(),
    traceFlags: TraceFlags.SAMPLED,
    isRemote: true,
  });
}

function startOtelSpan(
  input: TelemetrySpanInput,
  startedAt: number,
  parentContext: ReturnType<typeof getOtelParent>,
) {
  const tracer = getOtelTracer();
  const attributes = buildOtelAttributes(input);
  return tracer.startSpan(
    `${input.phase}.${input.step}`,
    {
      kind: SpanKind.INTERNAL,
      startTime: startedAt,
      attributes,
    },
    parentContext,
  );
}

function buildOtelAttributes(
  input: TelemetrySpanInput,
): Record<string, string | number | boolean> {
  const attrs: Record<string, string | number | boolean> = {
    "telemetry.phase": input.phase,
    "telemetry.step": input.step,
    "telemetry.component": input.component,
    traceId: input.traceId,
  };
  const flattened = flattenTelemetryContext(input);
  for (const [key, value] of Object.entries(flattened)) {
    const coerced = coerceOtelAttributeValue(value);
    if (coerced === undefined) {
      continue;
    }
    attrs[key] = coerced;
  }
  return attrs;
}

function coerceOtelAttributeValue(
  value: unknown,
): string | number | boolean | undefined {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value === "boolean") {
    return value;
  }
  return undefined;
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
