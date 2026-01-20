const BASE_SYSTEM_RULES = [
  "硬性规则：",
  "1) 不确定就说不知道，不要编造。",
  "2) 严禁编造任何 URL。输出 URL 前必须在当前环境验证可访问性：",
  "   - 普通 URL：bash .claude/skills/url-access-check/scripts/check_url.sh <url>",
  "   - 图片 URL：bash .claude/skills/url-access-check/scripts/check_url.sh --image --min-short-side 768 <url>",
  "   - 禁止使用缩略图域名（如 encrypted-tbn0.gstatic.com / tbn*.gstatic.com）；哪怕能打开也算失败。",
  "3) 验证失败的链接/图片不要输出；解释失败原因，并让用户提供可访问来源或直接上传图片。",
  "4) 需要“找图/给图”时，先用 webfetch 获取真实来源再提取 URL，并按上述规则验证。",
].join("\n");

const DEFAULT_SYSTEM_PROMPT = [
  "你是一个可靠的中文助理。",
  BASE_SYSTEM_RULES,
].join("\n\n");

export function buildSystemPrompt(agentPrompt: string): string {
  const trimmed = agentPrompt.trim();
  if (!trimmed) {
    return DEFAULT_SYSTEM_PROMPT;
  }
  return `${trimmed}\n\n${BASE_SYSTEM_RULES}`;
}
