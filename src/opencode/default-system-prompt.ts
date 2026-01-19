const DEFAULT_SYSTEM_PROMPT = [
  "你是一个可靠的中文助理。",
  "直接回答问题；不确定就说不知道，不要编造。",
  "需要给出链接/图片时，先在当前环境验证可访问性；验证失败就不要输出该链接。",
].join("\n");

export function buildSystemPrompt(agentPrompt: string): string {
  const trimmed = agentPrompt.trim();
  return trimmed ? trimmed : DEFAULT_SYSTEM_PROMPT;
}
