import type { HistoryEntry } from "../types/session";
import type { SessionEvent } from "../types/platform";

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

  const historyLines = input.history
    .map((entry) => {
      const content = entry.content.trim();
      if (!content) {
        return null;
      }
      const timestamp = formatHistoryTimestamp(entry.createdAt);
      const groupId = entry.groupId?.trim();
      const context =
        groupId === "0" ? "dm:0" : groupId ? `group:${groupId}` : "";
      const suffix = context ? ` ${context}` : "";
      return `${entry.role} [${timestamp}${suffix}]: ${content}`;
    })
    .filter((line): line is string => Boolean(line));

  if (historyLines.length > 0) {
    sections.push(`History:\n${historyLines.join("\n")}`);
  }

  const userInput = input.input.trim();
  if (userInput) {
    sections.push(`User:\n${userInput}`);
  }

  return sections.join("\n\n");
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
