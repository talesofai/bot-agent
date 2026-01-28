import { getConfig } from "../config";
import { redactSensitiveText } from "../utils/redact";

type FeishuWebhookPayload = {
  msg_type: "text";
  content: { text: string };
};

type FeishuWebhookClientOptions = {
  url: string;
  maxQueueSize: number;
  maxMessageBytes: number;
  minIntervalMs: number;
  timeoutMs: number;
};

class FeishuWebhookClient {
  private url: string;
  private maxQueueSize: number;
  private maxMessageBytes: number;
  private minIntervalMs: number;
  private timeoutMs: number;
  private queue: string[] = [];
  private draining = false;
  private lastSentAt = 0;

  constructor(options: FeishuWebhookClientOptions) {
    this.url = options.url;
    this.maxQueueSize = options.maxQueueSize;
    this.maxMessageBytes = options.maxMessageBytes;
    this.minIntervalMs = options.minIntervalMs;
    this.timeoutMs = options.timeoutMs;
  }

  enqueueText(text: string): void {
    const sanitized = sanitizeFeishuText(text, this.maxMessageBytes);
    if (!sanitized) {
      return;
    }

    if (this.queue.length >= this.maxQueueSize) {
      this.queue.shift();
    }
    this.queue.push(sanitized);

    void this.drain();
  }

  private async drain(): Promise<void> {
    if (this.draining) {
      return;
    }
    this.draining = true;
    try {
      while (this.queue.length > 0) {
        const next = this.queue.shift();
        if (!next) {
          continue;
        }
        const now = Date.now();
        const waitMs = Math.max(
          0,
          this.minIntervalMs - (now - this.lastSentAt),
        );
        if (waitMs > 0) {
          await sleep(waitMs);
        }
        await this.post(next);
        this.lastSentAt = Date.now();
      }
    } finally {
      this.draining = false;
    }
  }

  private async post(text: string): Promise<void> {
    const payload: FeishuWebhookPayload = {
      msg_type: "text",
      content: { text },
    };
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      await fetch(this.url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: controller.signal,
      }).catch(() => {});
    } finally {
      clearTimeout(timeout);
    }
  }
}

let cachedClient: FeishuWebhookClient | null = null;

function getClient(): FeishuWebhookClient | null {
  if (process.env.NODE_ENV === "test") {
    return null;
  }

  const config = getConfig();
  if (!config.FEISHU_LOG_ENABLED) {
    return null;
  }
  const url = config.FEISHU_WEBHOOK_URL?.trim();
  if (!url) {
    return null;
  }

  if (!cachedClient) {
    cachedClient = new FeishuWebhookClient({
      url,
      maxQueueSize: config.FEISHU_LOG_QUEUE_SIZE,
      maxMessageBytes: config.FEISHU_LOG_MAX_BYTES,
      minIntervalMs: config.FEISHU_LOG_MIN_INTERVAL_MS,
      timeoutMs: config.FEISHU_LOG_TIMEOUT_MS,
    });
  }
  return cachedClient;
}

export function feishuLogText(text: string): void {
  try {
    const client = getClient();
    if (!client) {
      return;
    }
    client.enqueueText(text);
  } catch {
    // Never block the main flow on logging.
  }
}

export function feishuLogJson(value: unknown): void {
  try {
    const raw = JSON.stringify(value, null, 2);
    feishuLogText(raw);
  } catch (err) {
    feishuLogText(
      JSON.stringify(
        {
          event: "feishu.log.json_failed",
          err: err instanceof Error ? err.message : String(err),
        },
        null,
        2,
      ),
    );
  }
}

function sanitizeFeishuText(text: string, maxBytes: number): string {
  const redacted = redactSensitiveText(String(text ?? ""));
  const trimmed = redacted.trim();
  if (!trimmed) {
    return "";
  }
  const truncated = truncateTextByBytes(trimmed, maxBytes);
  return truncated;
}

function truncateTextByBytes(content: string, maxBytes: number): string {
  if (maxBytes <= 0) {
    return "";
  }
  const buffer = Buffer.from(content, "utf8");
  if (buffer.byteLength <= maxBytes) {
    return content;
  }
  const sliced = buffer.toString("utf8", 0, maxBytes);
  return `${sliced}\n\n[truncated]`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
