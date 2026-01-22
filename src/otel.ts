import {
  diag,
  DiagConsoleLogger,
  DiagLogLevel,
  trace,
} from "@opentelemetry/api";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import {
  defaultResource,
  resourceFromAttributes,
} from "@opentelemetry/resources";
import { NodeSDK } from "@opentelemetry/sdk-node";
import {
  AlwaysOnSampler,
  ParentBasedSampler,
  TraceIdRatioBasedSampler,
} from "@opentelemetry/sdk-trace-base";
import { SemanticResourceAttributes } from "@opentelemetry/semantic-conventions";
import { getConfig } from "./config";

let sdk: NodeSDK | null = null;
let started = false;

export function isOtelStarted(): boolean {
  return started;
}

export function getOtelTracer() {
  return trace.getTracer("opencode-bot-agent");
}

export function startOtel(input: { defaultServiceName: string }): void {
  if (started) {
    return;
  }

  const endpoint = process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT?.trim();
  if (!endpoint) {
    return;
  }

  const config = getConfig();
  if (!config.TELEMETRY_ENABLED) {
    return;
  }
  const serviceName =
    process.env.OTEL_SERVICE_NAME?.trim() || input.defaultServiceName;
  const serviceNamespace = process.env.OTEL_SERVICE_NAMESPACE?.trim();
  const serviceVersion =
    process.env.APP_VERSION?.trim() ||
    process.env.npm_package_version?.trim() ||
    undefined;

  const sampleRate = Math.max(0, Math.min(1, config.TELEMETRY_SAMPLE_RATE));
  const sampler =
    sampleRate >= 1
      ? new AlwaysOnSampler()
      : new ParentBasedSampler({
          root: new TraceIdRatioBasedSampler(sampleRate),
        });

  const resource = defaultResource().merge(
    resourceFromAttributes({
      [SemanticResourceAttributes.SERVICE_NAME]: serviceName,
      ...(serviceNamespace
        ? { [SemanticResourceAttributes.SERVICE_NAMESPACE]: serviceNamespace }
        : {}),
      ...(serviceVersion
        ? { [SemanticResourceAttributes.SERVICE_VERSION]: serviceVersion }
        : {}),
      [SemanticResourceAttributes.DEPLOYMENT_ENVIRONMENT]:
        config.NODE_ENV ?? "production",
    }),
  );

  diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.ERROR);

  sdk = new NodeSDK({
    traceExporter: new OTLPTraceExporter({ url: endpoint }),
    sampler,
    resource,
  });
  sdk.start();
  started = true;
}

export async function shutdownOtel(): Promise<void> {
  if (!sdk) {
    return;
  }
  try {
    await sdk.shutdown();
  } finally {
    sdk = null;
    started = false;
  }
}
