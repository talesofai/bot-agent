import type { SessionJobData } from "../queue";
import type { OpencodeRequestSpec } from "../worker/runner";
import type { SessionEvent } from "../types/platform";
import type { HistoryKey } from "./history";
import type { SessionBufferKey } from "./buffer";
import type { SessionInfo } from "../types/session";
import { buildBotAccountId } from "../utils/bot-id";
import { parseWorldGroup } from "../world/ids";
import {
  parseOpencodeModelIdsCsv,
  selectOpencodeModelId,
} from "../opencode/model-ids";

const YOLO_TOOLS: Record<string, boolean> = {
  bash: true,
  read: true,
  write: true,
  edit: true,
  list: true,
  glob: true,
  grep: true,
  webfetch: true,
  task: true,
  todowrite: true,
  todoread: true,
  question: false,
};

const READONLY_TOOLS: Record<string, boolean> = {
  read: true,
  list: true,
  glob: true,
  grep: true,
  webfetch: true,
  task: true,
  todowrite: true,
  todoread: true,
  question: false,
};

export function resolveUserCreatedAt(
  timestamp: number | undefined,
  fallback: string,
): string {
  if (typeof timestamp !== "number" || !Number.isFinite(timestamp)) {
    return fallback;
  }
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) {
    return fallback;
  }
  return date.toISOString();
}

export function resolveSessionInput(content: string): string {
  const trimmed = content.trim();
  if (trimmed) {
    return content;
  }
  return " ";
}

export function readHttpStatusCode(err: unknown): number | null {
  if (!err || typeof err !== "object") {
    return null;
  }
  const status = (err as { status?: unknown }).status;
  return typeof status === "number" && Number.isFinite(status) ? status : null;
}

export function classifyOpencodeTimeoutPoint(input: {
  errName?: string;
  errMessage: string;
  status: number | null;
}): "opencode-server" | "worker->opencode-server" | null {
  const errName = input.errName?.trim() ?? "";
  const messageLower = (input.errMessage ?? "").toLowerCase();
  const isTimeoutLike =
    errName === "TimeoutError" || messageLower.includes("timed out");
  if (!isTimeoutLike) {
    return null;
  }
  if (typeof input.status === "number" && Number.isFinite(input.status)) {
    return "opencode-server";
  }
  return "worker->opencode-server";
}

export function parseWebfetchStatusCode(
  message: string | undefined,
): number | null {
  if (!message) {
    return null;
  }
  const match = message.match(/status code:\s*(\d{3})/i);
  if (!match) {
    return null;
  }
  const parsed = Number(match[1]);
  return Number.isInteger(parsed) ? parsed : null;
}

export function truncateLogPreview(text: string, maxChars: number): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxChars) {
    return normalized;
  }
  return `${normalized.slice(0, maxChars)}…`;
}

export function truncateTextByBytes(
  content: string,
  maxBytes: number,
): { content: string; truncated: boolean } {
  if (maxBytes <= 0) {
    return { content: "", truncated: content.length > 0 };
  }
  const buffer = Buffer.from(content, "utf-8");
  if (buffer.byteLength <= maxBytes) {
    return { content, truncated: false };
  }
  const truncated = buffer.toString("utf-8", 0, maxBytes);
  return { content: `${truncated}\n\n[truncated]`, truncated: true };
}

export function resolveOutput(output?: string): string | undefined {
  if (!output) {
    return undefined;
  }
  return output.trim() ? output : undefined;
}

export function resolveOpencodeAssistantMessageId(input: {
  opencodeAssistantMessageId?: string;
}): string | undefined {
  const id = input.opencodeAssistantMessageId;
  if (typeof id !== "string") {
    return undefined;
  }
  const trimmed = id.trim();
  return trimmed ? trimmed : undefined;
}

export function resolveHistoryKey(session: SessionEvent): HistoryKey | null {
  if (!session.selfId) {
    return null;
  }
  return {
    botAccountId: buildBotAccountId(session.platform, session.selfId),
    userId: session.userId,
  };
}

export function toBufferKey(jobData: SessionJobData): SessionBufferKey {
  return {
    botId: jobData.botId,
    groupId: jobData.groupId,
    sessionId: jobData.sessionId,
  };
}

export function resolveSessionTools(
  groupId: string,
): OpencodeRequestSpec["body"]["tools"] {
  const parsed = parseWorldGroup(groupId);
  if (parsed && parsed.kind === "play") {
    return READONLY_TOOLS;
  }
  return YOLO_TOOLS;
}

export function resolveModelRef(
  input: Readonly<{
    groupOverride: string | undefined;
    openaiBaseUrl: string | undefined;
    openaiApiKey: string | undefined;
    modelsCsv: string | undefined;
  }>,
): { providerID: string; modelID: string } {
  const externalBaseUrl = input.openaiBaseUrl?.trim();
  const externalApiKey = input.openaiApiKey?.trim();
  const modelsCsv = input.modelsCsv?.trim();
  const externalModeEnabled = Boolean(
    externalBaseUrl && externalApiKey && modelsCsv,
  );
  if (!externalModeEnabled) {
    return { providerID: "opencode", modelID: "glm-4.7-free" };
  }

  const allowed = parseOpencodeModelIdsCsv(modelsCsv!);
  const selected = selectOpencodeModelId(allowed, input.groupOverride);
  return { providerID: "litellm", modelID: selected };
}

export function buildOpencodeSessionTitle(sessionInfo: SessionInfo): string {
  const groupId = sessionInfo.meta.groupId;
  const location = groupId === "0" ? "dm:0" : `group:${groupId}`;
  return `${location} user:${sessionInfo.meta.ownerId} bot:${sessionInfo.meta.botId} sid:${sessionInfo.meta.sessionId} key:${sessionInfo.meta.key}`;
}

export function isLikelyOpencodeSessionId(value: string): boolean {
  return (
    /^ses_[0-9a-f]{12}[A-Za-z0-9]{14}$/.test(value) || value.startsWith("ses_")
  );
}

export function isAbortError(err: unknown): boolean {
  if (!err || typeof err !== "object") {
    return false;
  }
  const status = (err as { status?: unknown }).status;
  if (typeof status === "number" && Number.isFinite(status)) {
    return false;
  }
  const name = (err as { name?: unknown }).name;
  if (name === "AbortError" || name === "TimeoutError") {
    return true;
  }
  const message = (err as { message?: unknown }).message;
  return (
    typeof message === "string" && message.toLowerCase().includes("timed out")
  );
}
