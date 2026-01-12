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
      return `${entry.role}: ${content}`;
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
