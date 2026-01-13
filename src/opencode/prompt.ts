import type { HistoryEntry } from "../types/session";

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
      return `${entry.role} [${timestamp}]: ${content}`;
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

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}
