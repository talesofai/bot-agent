const BASE_SYSTEM_RULES = [
  "硬性规则：",
  "1) 不确定就说不知道，不要编造。",
  "2) 严禁编造任何 URL。输出 URL 前必须在当前环境验证可访问性：",
  "   - 普通 URL：bash .claude/skills/url-access-check/scripts/check_url.sh <url>",
  "   - 图片 URL：bash .claude/skills/url-access-check/scripts/check_url.sh --image --min-short-side 768 <url>",
  "   - 禁止使用缩略图域名（如 encrypted-tbn0.gstatic.com / tbn*.gstatic.com）；哪怕能打开也算失败。",
  "3) 验证失败的链接/图片不要输出；解释失败原因，并让用户提供可访问来源或直接上传图片。",
  "4) 需要“找图/给图”时：严禁输出搜索页/列表页/集合页链接（例如 Unsplash/Pixabay 的搜索页）。必须给至少 1 条可直接访问的图片直链，并按上述规则逐条验证。",
  '   - 推荐：bash .claude/skills/wikimedia-image-search/scripts/search_images.sh "<关键词>" --limit 2',
  "5) 如果找不到任何通过验证的图片直链：直接说明找不到，不要说“已附上/下面是图片”。",
].join("\n");

const DEFAULT_SYSTEM_PROMPT = [
  BASE_SYSTEM_RULES,
  "你是一个可靠的中文助理。",
].join("\n\n");

export function buildSystemPrompt(agentPrompt: string): string {
  const trimmed = agentPrompt.trim();
  if (!trimmed) {
    return DEFAULT_SYSTEM_PROMPT;
  }
  return `${BASE_SYSTEM_RULES}\n\n${trimmed}`;
}
