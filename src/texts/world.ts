import type { UserLanguage } from "../user/state-store";
import { pick } from "./common";

export function buildWorldSourceSeedContent(
  language: UserLanguage | null | undefined,
): string {
  return pick(
    language,
    [
      "# 设定原文（汇总）",
      "",
      "你在本话题里发送的设定文字 / 上传的设定文档，会自动追加到本文件。",
      "",
      "你可以继续：",
      "- 直接粘贴/分段发送设定原文（可多轮补全）",
      "- 或上传 txt/md/json/docx（会自动写入本文件）",
      "",
      "提示：无需在 /world create 里填写任何参数。",
      "",
    ].join("\n"),
    [
      "# Source Setting Material (Aggregated)",
      "",
      "Anything you send in this thread (text or uploaded documents) will be appended to this file automatically.",
      "",
      "You can continue by:",
      "- Pasting the setting text directly (you can send in multiple messages)",
      "- Or uploading txt/md/json/docx (will be appended here automatically)",
      "",
      "Note: /world create does not require any parameters.",
      "",
    ].join("\n"),
  );
}

export function buildCharacterSourceSeedContent(
  language: UserLanguage | null | undefined,
): string {
  return pick(
    language,
    [
      "# 角色设定原文（汇总）",
      "",
      "你在本话题里发送的设定文字 / 上传的设定文档，会自动追加到本文件。",
      "",
      "你可以继续：",
      "- 直接粘贴/分段发送角色设定（可多轮补全）",
      "- 或上传 txt/md/json/docx（会自动写入本文件）",
      "",
      "提示：整理后的结果会更新到“角色卡”。",
      "",
    ].join("\n"),
    [
      "# Character Source Material (Aggregated)",
      "",
      "Anything you send in this thread (text or uploaded documents) will be appended to this file automatically.",
      "",
      "You can continue by:",
      "- Pasting the character setting text directly (you can send in multiple messages)",
      "- Or uploading txt/md/json/docx (will be appended here automatically)",
      "",
      "Note: the normalized output will be written into the “Character Card”.",
      "",
    ].join("\n"),
  );
}

export function buildWorldAgentPrompt(input: {
  worldId: number;
  worldName: string;
  language: UserLanguage | null | undefined;
}): string {
  return pick(
    input.language,
    [
      "---",
      `name: World-${input.worldId}`,
      'version: "1"',
      "---",
      "",
      `你在世界系统中工作。当前世界：W${input.worldId} ${input.worldName}。`,
      "",
      "硬性规则：",
      "1) 世界正典与规则在会话工作区的 `world/world-card.md` 与 `world/rules.md`。回答前必须读取它们；不确定就说不知道，禁止编造。",
      "2) 如果 `world/active-character.md` 存在：这代表用户正在以该角色身份发言。你作为旁白/世界系统/GM回应，禁止替用户发言，更不能用第一人称扮演用户角色。",
      `3) 当前是游玩会话（只读）。当用户请求修改世界设定/正典时：不要直接改写文件；应引导联系世界创作者执行 /world open world_id:${input.worldId} 后修改，并用 /world publish 发布更新。`,
      "4) 游玩会话请遵循技能 `world-readonly` 的只读原则与回应风格。",
      "5) 内部可使用工作区路径读取资料，但对用户的回复里禁止出现任何路径/文件名；统一使用“世界书/角色卡”等产品术语。",
      "",
    ].join("\n"),
    [
      "---",
      `name: World-${input.worldId}`,
      'version: "1"',
      "---",
      "",
      `You are working within the world system. Current world: W${input.worldId} ${input.worldName}.`,
      "",
      "Hard rules:",
      "1) The world canon and rules are in the session workspace: `world/world-card.md` and `world/rules.md`. You must read them before replying; if unsure, say you don't know and do not invent.",
      "2) If `world/active-character.md` exists, it means the user is speaking as that character. Reply as narrator/world system/GM; never speak on behalf of the user, and do not roleplay the user's character in first person.",
      `3) This is a play session (read-only). If the user asks to change world settings/canon, do not edit files directly; instruct them to contact the world creator to run /world open world_id:${input.worldId} and then publish updates via /world publish.`,
      "4) Follow skill `world-readonly` for read-only behavior and response style in play sessions.",
      "5) You may use workspace paths internally, but never expose any path or filename in user-facing replies; use product terms like Worldbook / Character Card.",
      "",
    ].join("\n"),
  );
}

export function buildWorldSubmissionMarkdown(input: {
  worldId: number;
  worldName: string;
  submissionId: number;
  kind: "canon" | "chronicle" | "task" | "news";
  title: string;
  content: string;
  submitterUserId: string;
  createdAt: string;
  language: UserLanguage | null | undefined;
}): string {
  const title = input.title.trim();
  const content = input.content.trim();
  const submitter = input.submitterUserId.trim();

  return pick(
    input.language,
    [
      `# 世界提案（W${input.worldId} / S${input.submissionId}）`,
      "",
      `- 世界：W${input.worldId} ${input.worldName}`,
      `- 类型：${input.kind}`,
      `- 标题：${title || "(未命名)"}`,
      submitter ? `- 提交者：<@${submitter}>` : null,
      `- 时间：${input.createdAt}`,
      "",
      "## 内容",
      content || "(空)",
      "",
    ]
      .filter((line): line is string => Boolean(line))
      .join("\n"),
    [
      `# World Proposal (W${input.worldId} / S${input.submissionId})`,
      "",
      `- World: W${input.worldId} ${input.worldName}`,
      `- Type: ${input.kind}`,
      `- Title: ${title || "(untitled)"}`,
      submitter ? `- Submitter: <@${submitter}>` : null,
      `- Time: ${input.createdAt}`,
      "",
      "## Content",
      content || "(empty)",
      "",
    ]
      .filter((line): line is string => Boolean(line))
      .join("\n"),
  );
}

export function buildWorldBuildAgentPrompt(input: {
  worldId: number;
  worldName: string;
  language: UserLanguage | null | undefined;
}): string {
  return pick(
    input.language,
    [
      "---",
      `name: World-${input.worldId}-Build`,
      'version: "1"',
      "---",
      "",
      `你在世界系统中工作，当前是“世界创作/整理”模式：W${input.worldId} ${input.worldName}。`,
      "",
      "硬性规则：",
      "1) 必须读取：`world/source.md`。",
      "2) 必须写入：`world/world-card.md` 与 `world/rules.md`；必须通过工具写入/编辑，禁止只在聊天里输出。",
      "3) 世界构建流程与细节规范以技能 `world-design-card` 为准（包含外部资料处理规则）。",
      "4) 内部可使用路径，但对创作者回复禁止暴露路径/文件名；统一使用“世界书/角色卡”等产品术语。",
      "5) 每次回复包含：变更摘要 +（如信息不足）3-5 个补充问题；信息充分时明确“已 OK”，并提醒创作者执行 /world publish。",
      "6) 禁止使用交互式 question 工具；需要补充信息请直接在回复里列出问题。",
      "7) 不要 roleplay，不要编造未提供设定。",
      "",
    ].join("\n"),
    [
      "---",
      `name: World-${input.worldId}-Build`,
      'version: "1"',
      "---",
      "",
      `You are working within the world system in world authoring/normalization mode: W${input.worldId} ${input.worldName}.`,
      "",
      "Hard rules:",
      "1) You must read: `world/source.md`.",
      "2) You must write: `world/world-card.md` and `world/rules.md`; write/edit via tools only, never output final artifacts only in chat.",
      "3) Use skill `world-design-card` as the single source of truth for world-build workflow (including public-source handling).",
      "4) Paths are allowed internally, but never expose paths or filenames in creator-facing replies; use product terms like Worldbook / Character Card.",
      "5) Each reply includes: change summary + (if missing info) 3–5 follow-up questions; if sufficient, clearly say “OK” and remind creator to run /world publish.",
      "6) Do not use interactive question tools; ask follow-up questions directly in plain text.",
      "7) Do not roleplay and do not invent details not provided.",
      "",
    ].join("\n"),
  );
}

export function buildCharacterBuildAgentPrompt(input: {
  characterId: number;
  characterName: string;
  language: UserLanguage | null | undefined;
}): string {
  return pick(
    input.language,
    [
      "---",
      `name: Character-${input.characterId}-Build`,
      'version: "1"',
      "---",
      "",
      `你在世界系统中工作，当前是“角色卡创作/整理”模式：C${input.characterId} ${input.characterName}。`,
      "",
      "硬性规则：",
      "1) 必须读取：`character/source.md`。",
      "2) 必须写入：`character/character-card.md`；必须通过工具写入/编辑，禁止只在聊天里输出。",
      "3) 角色构建流程与字段规范以技能 `character-card` 为准。",
      "4) 内部可使用路径，但对创作者回复禁止暴露路径/文件名；统一使用“角色图书馆/角色卡”等产品术语。",
      "5) 每次回复包含：变更摘要 +（如信息不足）3-5 个补充问题；信息充分时明确“已 OK”。",
      "6) 禁止使用交互式 question 工具；需要补充信息请直接在回复里列出问题。",
      "7) 不要 roleplay，不要编造未提供设定。",
      "",
    ].join("\n"),
    [
      "---",
      `name: Character-${input.characterId}-Build`,
      'version: "1"',
      "---",
      "",
      `You are working within the world system in character-card authoring/normalization mode: C${input.characterId} ${input.characterName}.`,
      "",
      "Hard rules:",
      "1) You must read: `character/source.md`.",
      "2) You must write: `character/character-card.md`; write/edit via tools only, never output final artifacts only in chat.",
      "3) Use skill `character-card` as the single source of truth for character-card workflow and fields.",
      "4) Paths are allowed internally, but never expose paths or filenames in creator-facing replies; use product terms like Character Library / Character Card.",
      "5) Each reply includes: change summary + (if missing info) 3–5 follow-up questions; if sufficient, clearly say “OK”.",
      "6) Do not use interactive question tools; ask follow-up questions directly in plain text.",
      "7) Do not roleplay and do not invent details not provided.",
      "",
    ].join("\n"),
  );
}

export function buildWorldCharacterBuildAgentPrompt(input: {
  worldId: number;
  worldName: string;
  characterId: number;
  characterName: string;
  language: UserLanguage | null | undefined;
}): string {
  return pick(
    input.language,
    [
      "---",
      `name: World-${input.worldId}-Character-${input.characterId}-Build`,
      'version: "1"',
      "---",
      "",
      "你在世界系统中工作，当前是“世界专用角色卡修正”模式。",
      "",
      `世界：W${input.worldId} ${input.worldName}`,
      `角色：C${input.characterId} ${input.characterName}`,
      "",
      "硬性规则：",
      "1) 必须读取：`world/world-card.md` 与 `world/rules.md`（只读）。",
      "2) 必须写入：`character/character-card.md`（可写）。",
      "3) 禁止修改 world 文件；即使修改也不会保存。",
      "4) 世界适配流程以技能 `character-card` 为准。",
      "5) 内部可读取路径，但对创作者回复禁止暴露路径/文件名；统一使用“世界书/角色卡”等产品术语。",
      "6) 每次回复包含：变更摘要 +（如信息不足）3-5 个补充问题；信息充分时明确“已 OK”。",
      "7) 你不是来写小说的，不要 roleplay。",
      "",
    ].join("\n"),
    [
      "---",
      `name: World-${input.worldId}-Character-${input.characterId}-Build`,
      'version: "1"',
      "---",
      "",
      "You are working within the world system in world-specific character card correction mode.",
      "",
      `World: W${input.worldId} ${input.worldName}`,
      `Character: C${input.characterId} ${input.characterName}`,
      "",
      "Hard rules:",
      "1) You must read: `world/world-card.md` and `world/rules.md` (read-only).",
      "2) You must write: `character/character-card.md` (writable).",
      "3) Do not modify world files; even if you do, changes are not saved.",
      "4) Use skill `character-card` as the source of truth for world-specific adaptation workflow.",
      "5) Paths are allowed internally, but never expose paths or filenames in creator-facing replies; use product terms like Worldbook / Character Card.",
      "6) Each reply includes: change summary + (if missing info) 3–5 follow-up questions; if sufficient, clearly say “OK”.",
      "7) You are not here to write a novel; do not roleplay.",
      "",
    ].join("\n"),
  );
}

export function buildDefaultWorldCard(input: {
  worldId: number;
  worldName: string;
  creatorId: string;
  language: UserLanguage | null | undefined;
}): string {
  const name = input.worldName.trim() || `World-${input.worldId}`;
  return pick(
    input.language,
    [
      `# 世界观设计卡（W${input.worldId}）`,
      "",
      `- 世界名称：${name}`,
      `- 创建者：${input.creatorId}`,
      "- 类型标签：",
      "- 时代背景：",
      "- 一句话简介：",
      "- 核心元素：",
      "- 整体氛围：",
      "",
      "## 世界背景",
      "- 世界概述：",
      "- 起源/创世：",
      "- 历史背景：",
      "- 当前状态：",
      "- 核心冲突：",
      "",
      "## 社会设定",
      "- 政治体制：",
      "- 经济形态：",
      "- 科技水平：",
      "- 社会阶层：",
      "- 通用语言：",
      "- 货币体系：",
      "",
    ].join("\n"),
    [
      `# World Design Card (W${input.worldId})`,
      "",
      `- World Name: ${name}`,
      `- Creator: ${input.creatorId}`,
      "- Tags:",
      "- Era / Setting:",
      "- One-line Summary:",
      "- Core Elements:",
      "- Overall Tone:",
      "",
      "## World Background",
      "- Overview:",
      "- Origin / Creation:",
      "- History:",
      "- Current State:",
      "- Core Conflict:",
      "",
      "## Society",
      "- Political System:",
      "- Economy:",
      "- Technology Level:",
      "- Social Classes:",
      "- Common Language:",
      "- Currency:",
      "",
    ].join("\n"),
  );
}

export function buildDefaultWorldRules(
  language: UserLanguage | null | undefined,
): string {
  return pick(
    language,
    [
      "# 世界规则（底层逻辑）",
      "",
      "> 这是世界的硬性规则（正典）。未明确的部分允许在游玩中补全，但不得与已写规则冲突。",
      "",
      "## 玩家初始",
      "- 初始金额：",
      "- 初始装备：",
      "",
      "## 物理/超自然规则",
      "- （示例）遇水即融：否",
      "",
      "## 禁止事项",
      "- 禁止随意改写已发布正典；请走 /submit 或 /chronicle add",
      "",
    ].join("\n"),
    [
      "# World Rules (Core Logic)",
      "",
      "> These are the hard rules (canon). Unspecified parts can be filled during play, but must not contradict established rules.",
      "",
      "## Player Start",
      "- Starting Money:",
      "- Starting Equipment:",
      "",
      "## Physical / Supernatural Rules",
      "- (Example) Melts on contact with water: No",
      "",
      "## Prohibitions",
      "- Do not arbitrarily rewrite published canon; use /submit or /chronicle add",
      "",
    ].join("\n"),
  );
}

export function buildDefaultCharacterCard(input: {
  characterId: number;
  name: string;
  creatorId: string;
  description: string;
  language: UserLanguage | null | undefined;
}): string {
  const extra = input.description.trim();
  return pick(
    input.language,
    [
      `# 角色卡（C${input.characterId}）`,
      "",
      `- 角色名：${input.name}`,
      `- 创建者：${input.creatorId}`,
      extra ? `- 补充：${extra}` : "- 补充：",
      "",
      "## 外貌",
      "- 整体印象：",
      "- 发型发色：",
      "- 眼睛：",
      "- 体型身高：",
      "",
      "## 性格",
      "- 核心性格：",
      "- 说话风格：",
      "",
      "## 背景",
      "- 出身背景：",
      "- 关键经历：",
      "- 当前状态：",
      "",
    ].join("\n"),
    [
      `# Character Card (C${input.characterId})`,
      "",
      `- Name: ${input.name}`,
      `- Creator: ${input.creatorId}`,
      extra ? `- Notes: ${extra}` : "- Notes:",
      "",
      "## Appearance",
      "- Overall Impression:",
      "- Hair:",
      "- Eyes:",
      "- Build / Height:",
      "",
      "## Personality",
      "- Core Traits:",
      "- Speech Style:",
      "",
      "## Background",
      "- Origin:",
      "- Key Experiences:",
      "- Current Status:",
      "",
    ].join("\n"),
  );
}
