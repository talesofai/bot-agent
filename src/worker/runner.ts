import type { HistoryEntry, SessionInfo } from "../types/session";
import type { SessionJob } from "../queue";
import type { OpencodeRunResult } from "../opencode/output";
import type { OpencodeToolCall } from "../opencode/output";
import type { UserLanguage } from "../user/state-store";
import type {
  OpencodeClient,
  OpencodePromptBody,
  OpencodeAssistantMessageWithParts,
  OpencodeMessagePart,
} from "../opencode/server-client";
import { extractAssistantText } from "../opencode/server-client";
import {
  buildOpencodeQuestionToolFooter,
  buildOpencodeQuestionToolIntro,
  buildOpencodeQuestionToolNoQuestionsFallback,
} from "../texts";

export type { OpencodeRunResult } from "../opencode/output";

export interface OpencodeRequestSpec {
  directory: string;
  sessionId: string;
  body: OpencodePromptBody;
}

export interface OpencodeRunInput {
  job: SessionJob;
  session: SessionInfo;
  history: HistoryEntry[];
  request: OpencodeRequestSpec;
  language?: UserLanguage | null;
  signal?: AbortSignal;
}

export interface OpencodeRunner {
  run(input: OpencodeRunInput): Promise<OpencodeRunResult>;
}

export class OpencodeServerRunner implements OpencodeRunner {
  private client: OpencodeClient;

  constructor(client: OpencodeClient) {
    this.client = client;
  }

  async run(input: OpencodeRunInput): Promise<OpencodeRunResult> {
    if (input.signal?.aborted) {
      throw new Error("Opencode run aborted before start");
    }
    const createdAt = new Date().toISOString();
    const maxSteps = 6;

    let requestBody: OpencodePromptBody = input.request.body;
    const toolCalls: OpencodeToolCall[] = [];
    for (let step = 0; step < maxSteps; step += 1) {
      const response = await this.client.prompt({
        directory: input.request.directory,
        sessionId: input.request.sessionId,
        body: requestBody,
        signal: input.signal,
      });

      toolCalls.push(...extractToolCalls(response.parts ?? []));

      const output = extractAssistantText(response) ?? undefined;
      if (output?.trim()) {
        return {
          output,
          historyEntries: [
            { role: "assistant", content: output, createdAt },
          ] satisfies HistoryEntry[],
          toolCalls: toolCalls.length ? toolCalls : undefined,
        };
      }

      const questionText = formatQuestionToolAsText(
        response,
        input.language ?? null,
      );
      if (questionText) {
        return {
          output: questionText,
          historyEntries: [
            { role: "assistant", content: questionText, createdAt },
          ] satisfies HistoryEntry[],
          resetOpencodeSession: true,
          toolCalls: toolCalls.length ? toolCalls : undefined,
        };
      }

      if (!shouldContinueAfterToolCalls(response)) {
        return { toolCalls: toolCalls.length ? toolCalls : undefined };
      }

      // Opencode server may stop after tool-calls and expects the client to
      // "continue" the run. We send an empty placeholder message to progress.
      requestBody = {
        ...input.request.body,
        parts: [{ type: "text", text: " " }],
      };
    }

    return { toolCalls: toolCalls.length ? toolCalls : undefined };
  }
}

export class NoopOpencodeRunner implements OpencodeRunner {
  async run(): Promise<OpencodeRunResult> {
    return {};
  }
}

function shouldContinueAfterToolCalls(
  response: OpencodeAssistantMessageWithParts,
): boolean {
  const parts = response.parts ?? [];
  const hasQuestion = findToolPart(parts, "question") !== null;
  if (hasQuestion) {
    return false;
  }
  const hasToolCallsFinish = parts.some(
    (part) =>
      part.type === "step-finish" &&
      typeof part["reason"] === "string" &&
      part["reason"] === "tool-calls",
  );
  if (hasToolCallsFinish) {
    return true;
  }
  const hasAnyTool = parts.some((part) => part.type === "tool");
  return hasAnyTool;
}

function formatQuestionToolAsText(
  response: OpencodeAssistantMessageWithParts,
  language: UserLanguage | null,
): string | null {
  const parts = response.parts ?? [];
  const toolPart = findToolPart(parts, "question");
  if (!toolPart) {
    return null;
  }

  const state = isRecord(toolPart.state) ? toolPart.state : null;
  const input = state && isRecord(state.input) ? state.input : null;
  const questions =
    input && Array.isArray(input.questions) ? input.questions : [];
  if (questions.length === 0) {
    return buildOpencodeQuestionToolNoQuestionsFallback(language);
  }

  const lines: string[] = [];
  lines.push(buildOpencodeQuestionToolIntro(language));

  for (const rawQuestion of questions) {
    if (!isRecord(rawQuestion)) {
      continue;
    }
    const header =
      typeof rawQuestion.header === "string" ? rawQuestion.header.trim() : "";
    const question =
      typeof rawQuestion.question === "string"
        ? rawQuestion.question.trim()
        : "";
    if (header) {
      lines.push("", `【${header}】`);
    }
    if (question) {
      lines.push(question);
    }

    const options = Array.isArray(rawQuestion.options)
      ? rawQuestion.options
      : [];
    const renderedOptions = options
      .map((opt) => (isRecord(opt) ? opt : null))
      .filter(Boolean)
      .map((opt) => {
        const label = typeof opt!.label === "string" ? opt!.label.trim() : "";
        const desc =
          typeof opt!.description === "string" ? opt!.description.trim() : "";
        if (!label && !desc) {
          return null;
        }
        if (!desc) {
          return `- ${label}`;
        }
        if (!label) {
          return `- ${desc}`;
        }
        return `- ${label}：${desc}`;
      })
      .filter((line): line is string => Boolean(line));

    if (renderedOptions.length > 0) {
      lines.push(...renderedOptions);
    }
  }

  lines.push("", buildOpencodeQuestionToolFooter(language));
  const text = lines.join("\n").trim();
  return text ? text : null;
}

function findToolPart(
  parts: OpencodeMessagePart[],
  toolName: string,
): (OpencodeMessagePart & { state?: unknown; tool?: unknown }) | null {
  for (const part of parts) {
    if (part.type !== "tool") {
      continue;
    }
    const tool = typeof part.tool === "string" ? part.tool.trim() : "";
    if (tool === toolName) {
      return part;
    }
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function extractToolCalls(parts: OpencodeMessagePart[]): OpencodeToolCall[] {
  const calls: OpencodeToolCall[] = [];
  for (const part of parts) {
    if (part.type !== "tool") {
      continue;
    }
    const tool = typeof part.tool === "string" ? part.tool.trim() : "";
    if (!tool) {
      continue;
    }
    const state = isRecord(part.state) ? part.state : null;
    const status =
      state && typeof state.status === "string" ? state.status : "";
    const input = state && isRecord(state.input) ? state.input : null;
    const urls = input ? extractUrls(input) : [];
    const errorMessage = state ? extractToolErrorMessage(state) : null;

    calls.push({
      tool,
      status: status || undefined,
      urls: urls.length ? urls : undefined,
      errorMessage: errorMessage ?? undefined,
    });
  }
  return calls;
}

function extractToolErrorMessage(
  state: Record<string, unknown>,
): string | null {
  const error = isRecord(state.error) ? state.error : null;
  const errorMessage =
    (error && typeof error.message === "string" && error.message.trim()) || "";
  if (errorMessage) {
    return errorMessage.trim();
  }

  const output = state.output;
  if (typeof output === "string" && output.trim()) {
    return output.trim();
  }
  if (isRecord(output)) {
    const message =
      (typeof output.message === "string" && output.message.trim()) ||
      (typeof output.error === "string" && output.error.trim()) ||
      "";
    if (message) {
      return message.trim();
    }
  }
  return null;
}

function extractUrls(value: unknown): string[] {
  const urls = new Set<string>();
  const visited = new Set<unknown>();

  const walk = (node: unknown, depth: number): void => {
    if (depth <= 0 || node === null || node === undefined) {
      return;
    }
    if (typeof node === "string") {
      const trimmed = node.trim();
      if (trimmed.match(/^https?:\/\//i)) {
        urls.add(trimmed);
      }
      return;
    }
    if (Array.isArray(node)) {
      for (const item of node) {
        walk(item, depth - 1);
      }
      return;
    }
    if (!isRecord(node)) {
      return;
    }
    if (visited.has(node)) {
      return;
    }
    visited.add(node);

    for (const [key, child] of Object.entries(node)) {
      if (
        typeof child === "string" &&
        key.match(/url|href/i) &&
        child.trim().match(/^https?:\/\//i)
      ) {
        urls.add(child.trim());
      }
      walk(child, depth - 1);
    }
  };

  walk(value, 4);
  return [...urls];
}
