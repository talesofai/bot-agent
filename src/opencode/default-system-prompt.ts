import { buildSystemPrompt as buildSystemPromptFromTexts } from "../texts";

export function buildSystemPrompt(agentPrompt: string): string {
  return buildSystemPromptFromTexts(agentPrompt, "zh");
}
