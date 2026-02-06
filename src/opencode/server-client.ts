import { redactSensitiveText } from "../utils/redact";

export type OpencodeModelRef = {
  providerID: string;
  modelID: string;
};

export type OpencodePromptPartInput = {
  type: "text";
  text: string;
};

export type OpencodePromptBody = {
  messageID?: string;
  model?: OpencodeModelRef;
  agent?: string;
  noReply?: boolean;
  system?: string;
  tools?: Record<string, boolean>;
  parts: OpencodePromptPartInput[];
};

export type OpencodeSessionInfo = {
  id: string;
  title?: string;
  directory?: string;
  [key: string]: unknown;
};

export type OpencodeMessagePart = {
  type: string;
  text?: string;
  synthetic?: boolean;
  ignored?: boolean;
  [key: string]: unknown;
};

export type OpencodeMessageWithParts = {
  info: {
    id: string;
    sessionID: string;
    role: "assistant" | "user" | "system";
    time?: {
      created?: number;
      updated?: number;
      [key: string]: unknown;
    };
    [key: string]: unknown;
  };
  parts: OpencodeMessagePart[];
  [key: string]: unknown;
};

export type OpencodeAssistantMessageWithParts = {
  info: {
    id: string;
    sessionID: string;
    role: "assistant";
    [key: string]: unknown;
  };
  parts: OpencodeMessagePart[];
};

export interface OpencodeServerClientOptions {
  baseUrl: string;
  username?: string;
  password?: string;
  timeoutMs: number;
}

export interface OpencodeClient {
  createSession(input: {
    directory: string;
    title?: string;
    parentID?: string;
    signal?: AbortSignal;
  }): Promise<OpencodeSessionInfo>;
  deleteSession(input: {
    directory: string;
    sessionId: string;
    signal?: AbortSignal;
  }): Promise<boolean>;
  getSession(input: {
    directory: string;
    sessionId: string;
    signal?: AbortSignal;
  }): Promise<OpencodeSessionInfo | null>;
  listMessages(input: {
    directory: string;
    sessionId: string;
    signal?: AbortSignal;
  }): Promise<OpencodeMessageWithParts[]>;
  prompt(input: {
    directory: string;
    sessionId: string;
    body: OpencodePromptBody;
    signal?: AbortSignal;
  }): Promise<OpencodeAssistantMessageWithParts>;
}

export class OpencodeServerClient implements OpencodeClient {
  private baseUrl: string;
  private authHeader: string | null;
  private timeoutMs: number;

  constructor(options: OpencodeServerClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    const username = options.username?.trim() || "opencode";
    const password = options.password?.trim() || "";
    this.authHeader = password
      ? `Basic ${Buffer.from(`${username}:${password}`, "utf8").toString("base64")}`
      : null;
    this.timeoutMs = options.timeoutMs;
  }

  async createSession(input: {
    directory: string;
    title?: string;
    parentID?: string;
    signal?: AbortSignal;
  }): Promise<OpencodeSessionInfo> {
    const body: { title?: string; parentID?: string } = {};
    if (input.title?.trim()) {
      body.title = input.title.trim();
    }
    if (input.parentID?.trim()) {
      body.parentID = input.parentID.trim();
    }

    return await this.requestJson<OpencodeSessionInfo>({
      method: "POST",
      path: "/session",
      directory: input.directory,
      body,
      signal: input.signal,
    });
  }

  async deleteSession(input: {
    directory: string;
    sessionId: string;
    signal?: AbortSignal;
  }): Promise<boolean> {
    try {
      await this.requestJson({
        method: "DELETE",
        path: `/session/${encodeURIComponent(input.sessionId)}`,
        directory: input.directory,
        signal: input.signal,
      });
      return true;
    } catch (err) {
      if (isHttpError(err) && err.status === 404) {
        return false;
      }
      throw err;
    }
  }

  async getSession(input: {
    directory: string;
    sessionId: string;
    signal?: AbortSignal;
  }): Promise<OpencodeSessionInfo | null> {
    try {
      return await this.requestJson<OpencodeSessionInfo>({
        method: "GET",
        path: `/session/${encodeURIComponent(input.sessionId)}`,
        directory: input.directory,
        signal: input.signal,
      });
    } catch (err) {
      if (isHttpError(err) && err.status === 404) {
        return null;
      }
      throw err;
    }
  }

  async listMessages(input: {
    directory: string;
    sessionId: string;
    signal?: AbortSignal;
  }): Promise<OpencodeMessageWithParts[]> {
    return await this.requestJson<OpencodeMessageWithParts[]>({
      method: "GET",
      path: `/session/${encodeURIComponent(input.sessionId)}/message`,
      directory: input.directory,
      signal: input.signal,
    });
  }

  async prompt(input: {
    directory: string;
    sessionId: string;
    body: OpencodePromptBody;
    signal?: AbortSignal;
  }): Promise<OpencodeAssistantMessageWithParts> {
    return await this.requestJson<OpencodeAssistantMessageWithParts>({
      method: "POST",
      path: `/session/${encodeURIComponent(input.sessionId)}/message`,
      directory: input.directory,
      body: input.body,
      signal: input.signal,
    });
  }

  private async requestJson<T>(input: {
    method: "GET" | "POST" | "PATCH" | "DELETE";
    path: string;
    directory: string;
    body?: unknown;
    signal?: AbortSignal;
  }): Promise<T> {
    const url = `${this.baseUrl}${input.path}`;
    const headers = new Headers();
    headers.set("Accept", "application/json");
    headers.set("x-opencode-directory", input.directory);
    if (this.authHeader) {
      headers.set("Authorization", this.authHeader);
    }
    if (input.body !== undefined) {
      headers.set("Content-Type", "application/json");
    }

    const controller = new AbortController();
    const abort = () => controller.abort();
    const timeout = setTimeout(abort, this.timeoutMs);
    input.signal?.addEventListener("abort", abort, { once: true });

    try {
      const res = await fetch(url, {
        method: input.method,
        headers,
        body: input.body !== undefined ? JSON.stringify(input.body) : undefined,
        signal: controller.signal,
      });
      const raw = await res.text();
      if (!res.ok) {
        throw new HttpError(res.status, formatHttpErrorMessage(raw));
      }
      const parsed = safeJsonParse(raw);
      if (parsed === null) {
        throw new Error("Opencode server returned non-JSON response");
      }
      return parsed as T;
    } finally {
      clearTimeout(timeout);
      input.signal?.removeEventListener("abort", abort);
    }
  }
}

export function extractAssistantText(
  message: OpencodeAssistantMessageWithParts,
): string | null {
  const parts = message.parts ?? [];
  const textParts = parts
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => String(part.text));
  const combined = textParts.join("");
  const trimmed = combined.trim();
  return trimmed ? trimmed : null;
}

function safeJsonParse(raw: string): unknown | null {
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return null;
  }
}

function formatHttpErrorMessage(raw: string): string {
  const text = redactSensitiveText(String(raw ?? ""));
  const trimmed = text.trim();
  if (!trimmed) {
    return "empty response";
  }
  const bunFallbackSummary = tryFormatBunFallbackError(trimmed);
  if (bunFallbackSummary) {
    return bunFallbackSummary;
  }
  const maxBytes = 20_000;
  const buffer = Buffer.from(trimmed, "utf8");
  if (buffer.byteLength <= maxBytes) {
    return trimmed;
  }
  return `${buffer.toString("utf8", 0, maxBytes)}\n\n[truncated]`;
}

class HttpError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "HttpError";
    this.status = status;
  }
}

function isHttpError(value: unknown): value is HttpError {
  return value instanceof HttpError;
}

function tryFormatBunFallbackError(html: string): string | null {
  // Bun's fallback error overlay encodes the underlying exception in a base64
  // script tag. The raw HTML is huge and Feishu logs truncate it before the
  // actual error becomes visible.
  if (!html.includes("__bunfallback")) {
    return null;
  }
  const match = html.match(
    /<script[^>]*id=["']__bunfallback["'][^>]*>([\s\S]*?)<\/script>/i,
  );
  if (!match) {
    return null;
  }

  const base64 = match[1]?.trim().replace(/\s+/g, "") ?? "";
  if (!base64) {
    return null;
  }

  let decoded: Buffer;
  try {
    decoded = Buffer.from(base64, "base64");
  } catch {
    return null;
  }
  if (decoded.byteLength === 0) {
    return null;
  }

  const runs = extractAsciiRuns(decoded)
    .map((run) => run.trim())
    .filter(Boolean);
  if (runs.length === 0) {
    return null;
  }

  const uniqueRuns: string[] = [];
  for (const run of runs) {
    if (!uniqueRuns.includes(run)) {
      uniqueRuns.push(run);
    }
  }

  const requestLine =
    uniqueRuns.find((run) =>
      /^(GET|POST|PUT|PATCH|DELETE)\s+-\s+/i.test(run),
    ) ?? null;

  const errorNameIndex = uniqueRuns.findIndex((run) => {
    if (!run) {
      return false;
    }
    if (run === "ExceptionOcurred") {
      return false;
    }
    return run.endsWith("Error");
  });
  const errorName =
    errorNameIndex >= 0 ? uniqueRuns[errorNameIndex] : (null as string | null);

  const errorMessage =
    errorNameIndex >= 0
      ? (uniqueRuns
          .slice(errorNameIndex + 1)
          .find(
            (run) =>
              run &&
              run !== requestLine &&
              run !== "/data" &&
              run !== "ExceptionOcurred" &&
              !/^(GET|POST|PUT|PATCH|DELETE)\s+-\s+/i.test(run),
          ) ?? null)
      : null;

  const parts: string[] = [];
  if (errorName) {
    parts.push(errorMessage ? `${errorName}: ${errorMessage}` : errorName);
  }
  if (requestLine) {
    parts.push(requestLine);
  }

  const formatted = parts.join(" | ").trim();
  return formatted ? formatted : null;
}

function extractAsciiRuns(buffer: Buffer): string[] {
  const runs: string[] = [];
  let start = -1;
  for (let i = 0; i < buffer.length; i += 1) {
    const byte = buffer[i]!;
    const printable = byte >= 32 && byte < 127;
    if (printable) {
      if (start === -1) {
        start = i;
      }
      continue;
    }
    if (start !== -1 && i - start >= 4) {
      runs.push(buffer.toString("ascii", start, i));
    }
    start = -1;
  }
  if (start !== -1 && buffer.length - start >= 4) {
    runs.push(buffer.toString("ascii", start));
  }
  return runs;
}
