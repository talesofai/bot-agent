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
    if (isRecord(value) && !shouldSendToFeishu(value)) {
      return;
    }
    feishuLogText(formatLogLine(value));
  } catch (err) {
    feishuLogText(
      JSON.stringify(
        {
          event: "feishu.log.format_failed",
          err: err instanceof Error ? err.message : String(err),
        },
        null,
        2,
      ),
    );
  }
}

function shouldSendToFeishu(record: Record<string, unknown>): boolean {
  const event = typeof record.event === "string" ? record.event.trim() : "";
  if (!event) {
    return false;
  }

  // Only keep: warn/error + all message I/O (Discord only for now).
  if (event === "log.warn" || event === "log.error") {
    return true;
  }
  if (event === "io.recv" || event === "io.send") {
    return true;
  }
  if (event === "discord.command.start" || event === "discord.command.reply") {
    return true;
  }
  if (event === "ai.start" || event === "ai.finish") {
    return true;
  }

  return false;
}

function formatLogLine(value: unknown): string {
  const ts = new Date().toISOString();
  if (isRecord(value)) {
    const formatted = formatFeishuEvent(value);
    if (formatted) {
      return `${ts} ${formatted}`;
    }
    return `${ts} ${formatLogfmt(value)}`;
  }
  const raw = redactSensitiveText(String(value ?? ""));
  const trimmed = raw.trim();
  return trimmed ? `${ts} ${trimmed}` : ts;
}

function formatFeishuEvent(record: Record<string, unknown>): string | null {
  const event = typeof record.event === "string" ? record.event.trim() : "";
  if (!event) {
    return null;
  }

  const platform = readString(record.platform);
  const traceId = readString(record.traceId);
  const guildId = readString(record.guildId);
  const groupId = readString(record.groupId);
  const channelId = readString(record.channelId);
  const userId = readString(record.userId);
  const messageId = readString(record.messageId);
  const worldId = readNumber(record.worldId);
  const characterId = readNumber(record.characterId);

  const location = [
    platform ? `p:${platform}` : null,
    guildId ? `g:${guildId}` : null,
    channelId ? `c:${channelId}` : null,
    groupId ? `group:${groupId}` : null,
    userId ? `u:${userId}` : null,
    worldId ? `W${worldId}` : null,
    characterId ? `C${characterId}` : null,
    traceId ? `t:${traceId}` : null,
    messageId ? `m:${messageId}` : null,
  ]
    .filter((v): v is string => Boolean(v))
    .join(" ");

  if (event === "io.recv") {
    const preview = readString(record.contentPreview);
    return [`【收】`, location, preview ? `：${preview}` : null]
      .filter((v): v is string => Boolean(v))
      .join("");
  }
  if (event === "io.send") {
    const preview = readString(record.contentPreview);
    return [`【发】`, location, preview ? `：${preview}` : null]
      .filter((v): v is string => Boolean(v))
      .join("");
  }
  if (event === "discord.command.start") {
    const command = readString(record.command);
    return [`【指令】`, location, command ? ` /${command}` : ""].join("");
  }
  if (event === "discord.command.reply") {
    const command = readString(record.command);
    const preview = readString(record.contentPreview);
    const ephemeral = record.ephemeral === true ? "（ephemeral）" : "";
    return [
      `【指令回复】`,
      location,
      command ? ` /${command}${ephemeral}` : ephemeral,
      preview ? `：${preview}` : "",
    ].join("");
  }
  if (event === "ai.start") {
    const key = readNumber(record.key);
    return [`【AI开始】`, location, key !== null ? ` key:${key}` : ""].join("");
  }
  if (event === "ai.finish") {
    const key = readNumber(record.key);
    const preview = readString(record.outputPreview);
    return [
      `【AI结束】`,
      location,
      key !== null ? ` key:${key}` : "",
      preview ? `：${preview}` : "",
    ].join("");
  }
  if (event === "log.warn" || event === "log.error") {
    const level = event === "log.error" ? "【WARN以上-ERROR】" : "【WARN】";
    const msg = readString(record.msg);
    const component = readString(record.component);
    const step = readString(record.step);
    const timeoutPoint = readString(record.timeoutPoint);
    const errName = readString(record.errName);
    const errMessage = readString(record.errMessage);
    const parts = [
      level,
      location,
      component ? ` component:${component}` : null,
      step ? ` step:${step}` : null,
      msg ? ` msg:${msg}` : null,
      timeoutPoint ? ` timeout:${timeoutPoint}` : null,
      errName || errMessage
        ? ` err:${[errName, errMessage].filter(Boolean).join(":")}`
        : null,
    ].filter((v): v is string => Boolean(v));
    return parts.join(" ");
  }

  return null;
}

function readString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = redactSensitiveText(value).trim();
  return trimmed ? truncateFeishu(trimmed, 600) : null;
}

function readNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function truncateFeishu(input: string, maxChars: number): string {
  if (input.length <= maxChars) {
    return input;
  }
  return `${input.slice(0, maxChars)}…`;
}

function formatLogfmt(record: Record<string, unknown>): string {
  const ordered = orderKeys(record);
  const parts = ordered.flatMap((key) => {
    const value = record[key];
    const rendered = renderLogfmtValue(key, value);
    return rendered === null ? [] : [`${key}=${rendered}`];
  });
  return parts.length > 0 ? parts.join(" ") : "-";
}

function orderKeys(record: Record<string, unknown>): string[] {
  const preferred = [
    "event",
    "action",
    "service",
    "traceId",
    "phase",
    "step",
    "component",
    "ok",
    "durationMs",
    "startedAt",
    "endedAt",
    "jobId",
    "platform",
    "command",
    "subcommand",
    "interactionId",
    "messageId",
    "guildId",
    "groupId",
    "channelId",
    "userId",
    "worldId",
    "characterId",
  ];

  const keys = Object.keys(record).filter((key) => {
    const value = record[key];
    return value !== undefined && value !== null && String(value).trim() !== "";
  });

  const preferredIndex = new Map<string, number>();
  preferred.forEach((key, idx) => preferredIndex.set(key, idx));

  return keys.sort((a, b) => {
    const ai = preferredIndex.get(a);
    const bi = preferredIndex.get(b);
    if (ai !== undefined && bi !== undefined) {
      return ai - bi;
    }
    if (ai !== undefined) {
      return -1;
    }
    if (bi !== undefined) {
      return 1;
    }
    return a.localeCompare(b);
  });
}

function renderLogfmtValue(key: string, value: unknown): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? String(value) : null;
  }
  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }

  if (typeof value === "string") {
    const normalized = redactSensitiveText(value)
      .replace(/\r\n/g, "\n")
      .replace(/\r/g, "\n")
      .replace(/\n+/g, "\\n")
      .trim();
    if (!normalized) {
      return null;
    }
    const capped = truncateTextByBytes(normalized, capBytesForKey(key));
    return JSON.stringify(capped);
  }

  try {
    const raw = redactSensitiveText(JSON.stringify(value));
    const normalized = raw.replace(/\s+/g, " ").trim();
    if (!normalized) {
      return null;
    }
    const capped = truncateTextByBytes(normalized, capBytesForKey(key));
    return JSON.stringify(capped);
  } catch {
    return JSON.stringify(String(value));
  }
}

function capBytesForKey(key: string): number {
  const lowered = key.toLowerCase();
  if (lowered.includes("preview")) {
    return 1200;
  }
  if (lowered.includes("message")) {
    return 800;
  }
  return 400;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
