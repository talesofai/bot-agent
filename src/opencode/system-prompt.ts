const MCP_USAGE_METHOD = [
  "# MCP Usage",
  "- Use MCP tools when external actions or fresh data are required.",
  "- Provide clear tool arguments in JSON.",
  "- Prefer tool calls over speculation when a tool can answer.",
].join("\n");

export function buildSystemPrompt(agentPrompt: string): string {
  const trimmed = agentPrompt.trim();
  if (!trimmed) {
    return MCP_USAGE_METHOD;
  }
  return `${trimmed}\n\n${MCP_USAGE_METHOD}`;
}
