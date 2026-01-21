import type { HistoryEntry } from "../types/session";
import type { SessionEvent } from "../types/platform";
import { appendInputAuditIfSuspicious } from "./input-audit";

export interface OpencodePromptInput {
  systemPrompt: string;
  history: HistoryEntry[];
  input: string;
}

export function buildOpencodePrompt(input: OpencodePromptInput): string {
  const sections: string[] = [];
  const systemPrompt = input.systemPrompt.trim();
  if (systemPrompt) {
    sections.push(`System:\n${systemPrompt}`);
  }

  const grouped = groupHistoryLines(input.history);
  if (grouped.groupWindow.length > 0) {
    sections.push(`History (群窗口):\n${grouped.groupWindow.join("\n")}`);
  }
  if (grouped.userMemory.length > 0) {
    sections.push(`History (跨群记忆):\n${grouped.userMemory.join("\n")}`);
  }
  if (grouped.other.length > 0) {
    sections.push(`History:\n${grouped.other.join("\n")}`);
  }

  const userInput = input.input.trim();
  if (userInput) {
    sections.push(`User:\n${appendInputAuditIfSuspicious(userInput)}`);
  }

  return sections.join("\n\n");
}

export function buildOpencodeSystemContext(input: {
  systemPrompt: string;
  history: HistoryEntry[];
}): string {
  const sections: string[] = [];
  const systemPrompt = input.systemPrompt.trim();
  if (systemPrompt) {
    sections.push(systemPrompt);
  }

  const grouped = groupHistoryLines(input.history);
  if (grouped.groupWindow.length > 0) {
    sections.push(`群窗口:\n${grouped.groupWindow.join("\n")}`);
  }
  if (grouped.userMemory.length > 0) {
    sections.push(`跨群记忆:\n${grouped.userMemory.join("\n")}`);
  }
  if (grouped.other.length > 0) {
    sections.push(`历史:\n${grouped.other.join("\n")}`);
  }

  return sections.join("\n\n").trim();
}

function groupHistoryLines(history: HistoryEntry[]): {
  groupWindow: string[];
  userMemory: string[];
  other: string[];
} {
  const groupWindow: string[] = [];
  const userMemory: string[] = [];
  const other: string[] = [];

  for (const entry of history) {
    const line = formatHistoryLine(entry);
    if (!line) {
      continue;
    }
    const context = entry.context;
    if (context === "group_window") {
      groupWindow.push(line);
      continue;
    }
    if (context === "user_memory") {
      userMemory.push(line);
      continue;
    }
    other.push(line);
  }

  return { groupWindow, userMemory, other };
}

function formatHistoryLine(entry: HistoryEntry): string | null {
  const content = entry.content.trim();
  if (!content) {
    return null;
  }
  const timestamp = formatHistoryTimestamp(entry.createdAt);
  const groupId = entry.groupId?.trim();
  const location = groupId === "0" ? "dm:0" : groupId ? `group:${groupId}` : "";

  const userIdRaw = entry.userId;
  const userId =
    typeof userIdRaw === "string" && userIdRaw.trim() ? userIdRaw.trim() : "";

  const parts = [timestamp];
  if (location) {
    parts.push(location);
  }
  if (userId) {
    parts.push(`user:${userId}`);
  }
  const label = parts.join(" ");

  return `${entry.role} [${label}]: ${content}`;
}

export function buildBufferedInput(messages: SessionEvent[]): {
  mergedSession: SessionEvent;
  promptInput: string;
} {
  const last = messages[messages.length - 1];
  const mergedContent = mergeMessageContents(messages);
  const promptInput = formatBufferedMessages(messages);
  return {
    mergedSession: {
      ...last,
      content: mergedContent,
      elements: mergedContent ? [{ type: "text", text: mergedContent }] : [],
    },
    promptInput,
  };
}

function formatHistoryTimestamp(iso: string): string {
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) {
    return iso;
  }
  const year = parsed.getFullYear();
  const month = pad2(parsed.getMonth() + 1);
  const day = pad2(parsed.getDate());
  const hour = pad2(parsed.getHours());
  const minute = pad2(parsed.getMinutes());
  const second = pad2(parsed.getSeconds());
  const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][
    parsed.getDay()
  ];
  return `${year}-${month}-${day} ${hour}:${minute}:${second} ${weekday}`;
}

function formatBufferedMessages(messages: SessionEvent[]): string {
  return messages
    .map((message) => formatBufferedMessage(message))
    .filter((line) => line.length > 0)
    .join("\n");
}

function mergeMessageContents(messages: SessionEvent[]): string {
  return messages
    .map((message) => message.content.trim())
    .filter((content) => content.length > 0)
    .join("\n");
}

function formatBufferedMessage(message: SessionEvent): string {
  const timestamp = new Date(message.timestamp).toISOString();
  const content = message.content.trim() ? message.content.trim() : "<empty>";
  return `- [${timestamp}] ${content}`;
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}
