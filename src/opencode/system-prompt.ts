export function buildSystemPrompt(agentPrompt: string): string {
  const trimmed = agentPrompt.trim();
  if (!trimmed) {
    return "You are a helpful assistant.";
  }
  return trimmed;
}
