import type { UserLanguage, UserRole } from "../user/state-store";
import { pick } from "./common";

export function buildDiscordOnboardingAutoPrompt(
  language: UserLanguage | null | undefined,
): string {
  return pick(
    language,
    [
      `【新手引导】`,
      `这是你专属的私密引导话题（只有你和 bot 能看到）。`,
      `它位于服务器侧边栏的私密频道里（频道名以 \`onboarding-\` 开头）。`,
      `你可以在本话题里直接对 bot 说话（无需 @）。`,
      `如果你把它关掉了/找不到：重新执行一次 /onboard，我会把入口链接再发给你。`,
      ``,
      `请选择身份（可多次执行，允许多选）：`,
      `- /onboard role:admin`,
      `- /onboard role:adventurer`,
      `- /onboard role:world creater`,
      `- /onboard role:both（= 同时是后两者）`,
      ``,
      `机器人不说话？在公共频道需要 @bot 或“唤醒词”（群配置 keywords）开头；但 /nano /polish /quest 和掷骰（如 .rd 2d6）免 @。`,
      ``,
      `可选：设置语言 /language lang:zh|en`,
      ``,
      `提示：/help 查看所有指令。`,
    ].join("\n"),
    [
      `[Onboarding]`,
      `This is your private onboarding thread (only you and the bot can see it).`,
      `You can find it under a private channel in the server sidebar (channel name starts with \`onboarding-\`).`,
      `You can talk to the bot directly in this thread (no @ needed).`,
      `If you closed/lost it: run /onboard again and I will post the entry link again.`,
      ``,
      `Pick roles (you can run multiple times):`,
      `- /onboard role:admin`,
      `- /onboard role:adventurer`,
      `- /onboard role:world creater`,
      `- /onboard role:both (adventurer + world creater)`,
      ``,
      `Bot not replying? In public channels, you usually need to @mention the bot or start with a wake word (group keywords). But /nano /polish /quest and dice (e.g. .rd 2d6) work without @.`,
      ``,
      `Optional: set language /language lang:zh|en`,
      ``,
      `Tip: /help to view all commands.`,
    ].join("\n"),
  );
}

export function buildDiscordHelp(
  language: UserLanguage | null | undefined,
): string {
  return pick(
    language,
    [
      "【新手导航（最快上手）】",
      "1) 先选身份：`/onboard role:adventurer` 或 `/onboard role:world creater`（或 `/onboard role:both`）",
      "2) 世界创建者：`/world create` → 在编辑话题里粘贴/上传设定 → `/world publish`",
      "3) 冒险者：`/character create` → `/world list`/`/world search` → `/world join` → `/character act`",
      "4) 机器人不说话？公共频道需要 `@bot` 或“唤醒词”（群配置 keywords）开头；但下面这些**消息命令免 @**。",
      "",
      "【消息命令（普通聊天消息，不是 Discord Slash Command）】",
      "- 直接发一条消息（按回车），不要从输入框弹出的 Slash Command 列表里选。",
      "- `/nano ...` 画图/生成图片",
      "- `/polish ...` 润色改写（不新增设定）",
      "- `/quest ...` 给出 3–5 个下一步小任务",
      "- `.rd 2d6` / `.rd 10d20` 掷骰（格式：.rd NdM）",
      "",
      "【Slash Commands】",
      "- `/world help` / `/character help`（详细帮助）",
      "- `/language lang:zh|en`",
      "- `/reset` / `/resetall`",
      "- `/model` / `/ping` / `/help`",
    ].join("\n"),
    [
      "[Quick Start]",
      "1) Pick roles: `/onboard role:adventurer` or `/onboard role:world creater` (or `/onboard role:both`)",
      "2) World Creater: `/world create` → paste/upload lore in the editing thread → `/world publish`",
      "3) Adventurer: `/character create` → `/world list`/`/world search` → `/world join` → `/character act`",
      "4) Bot not replying? In public channels, you usually need to @mention the bot or start with a wake word (group keywords). But the message commands below work without @.",
      "",
      "[Message Commands (normal messages, NOT Discord slash commands)]",
      "- Send them as a normal chat message (press Enter). Do NOT pick from the slash-command popup.",
      "- `/nano ...` generate an image",
      "- `/polish ...` rewrite/polish (no new canon)",
      "- `/quest ...` propose 3–5 actionable next steps",
      "- `.rd 2d6` / `.rd 10d20` roll dice (format: .rd NdM)",
      "",
      "[Slash Commands]",
      "- `/world help` / `/character help` (detailed help)",
      "- `/language lang:zh|en`",
      "- `/reset` / `/resetall`",
      "- `/model` / `/ping` / `/help`",
    ].join("\n"),
  );
}

export function buildDiscordOnboardingGuide(input: {
  role: UserRole;
  language: UserLanguage | null | undefined;
}): string {
  if (input.role === "admin") {
    return pick(
      input.language,
      [
        "【管理员指南】",
        "",
        "你将以“管理员”的身份开始配置与维护本服务器的 bot。",
        "",
        "常用操作：",
        "- /language lang:zh|en：设置默认语言（也影响世界与角色文档写入语言）",
        "- 群配置 `world.createPolicy`：默认仅管理员可创建世界（可改为 open/whitelist）",
        "- /resetall：重置全群会话（仅管理员）",
        "- /model：设置/清理群模型覆盖（仅管理员）",
        "",
        "提示：",
        "- 你也可以同时是冒险者/世界创建者：再执行一次 /onboard role:adventurer 或 /onboard role:world creater 即可。",
        "- 本私密引导话题里可直接对 bot 说话（无需 @）；公共频道需要 @bot 或唤醒词。",
      ].join("\n"),
      [
        "[Admin Guide]",
        "",
        'You will start as an "admin" to configure and maintain the bot for this server.',
        "",
        "Common actions:",
        "- /language lang:zh|en: set your default language (also affects world and character document writing language)",
        "- World creation permission: /world create is admin-only by default (configurable via group config world.createPolicy = open/whitelist)",
        "- /resetall: reset all sessions (admin-only)",
        "- /model: set/clear the guild model override (admin-only)",
        "",
        "Notes:",
        "- You can also be an adventurer/world creater: run /onboard role:adventurer or /onboard role:world creater again.",
        "- In this onboarding thread, you can talk to the bot directly (no @ needed). In public channels, you may need to @mention the bot or use wake words.",
      ].join("\n"),
    );
  }

  if (input.role === "world creater") {
    return pick(
      input.language,
      [
        "【世界创建者指南】",
        "",
        "你将以“世界创建者”的身份开始创作。",
        "",
        "流程：",
        "1) 执行 /world create。",
        "2) 系统会创建一个编辑话题，你可以：粘贴设定原文/上传 txt|md|json|docx。",
        "3) 设定会被整理进「世界书」（世界卡 + 规则），信息不足时我会追问。",
        "4) 确认无误后执行 /world publish 发布世界。",
        "",
        "提示：",
        "- 编辑话题会长期保留；后续可以继续编辑来更新设定。",
        "- 如果你找不到这个私密引导话题：在侧边栏找 `onboarding-` 开头的私密频道；或再执行一次 /onboard role:world creater，我会把入口链接再发给你。",
        "- 在本私密引导话题里可直接对 bot 说话（无需 @）；公共频道则需要 @bot 或唤醒词。",
      ].join("\n"),
      [
        "[World Creater Guide]",
        "",
        'You will start as a "world creater".',
        "",
        "Workflow:",
        "1) Run /world create.",
        "2) The system will create an editing thread. You can paste the source lore or upload txt|md|json|docx.",
        "3) The content will be normalized into the “Worldbook” (World Card + Rules). If information is missing, the bot will ask follow-up questions.",
        "4) When everything looks good, run /world publish to publish the world.",
        "",
        "Notes:",
        "- The editing thread is persistent; you can keep editing later to update the canon.",
        "- If you lose this private onboarding thread: look for a private channel named like `onboarding-...` in the server sidebar, or run /onboard role:world creater again.",
        "- In this onboarding thread, you can talk to the bot directly (no @ needed). In public channels, you may need to @mention the bot or use wake words.",
      ].join("\n"),
    );
  }

  return pick(
    input.language,
    [
      "【冒险者指南】",
      "",
      "你将以“冒险者”的身份开始游玩。",
      "",
      "流程：",
      "1) 创建角色卡：/character create（会创建一个编辑话题，多轮补全）。",
      "2) 选择世界：用 /world list 或 /world search 找到世界 ID。",
      "3) 查看世界：/world info world_id:<ID>（可看到世界名、一句话简介、规则等）。",
      "4) 加入世界：/world join world_id:<ID>（加入后你才有发言权限）。",
      "5) 设置你在该世界的当前角色：/character act character_id:<ID>（世界内执行）。",
      "",
      "提示：",
      "- 你可以创建多张角色卡，也可以加入多个世界。",
      "- 角色卡可设为 public 供他人检索（/character publish）。",
      "- 如果你找不到这个私密引导话题：在侧边栏找 `onboarding-` 开头的私密频道；或再执行一次 /onboard role:adventurer，我会把入口链接再发给你。",
      "- 在本私密引导话题里可直接对 bot 说话（无需 @）；公共频道则需要 @bot 或唤醒词。",
    ].join("\n"),
    [
      "[Adventurer Guide]",
      "",
      'You will start as an "adventurer".',
      "",
      "Workflow:",
      "1) Create a character card: /character create (creates an editing thread for iterative refinement).",
      "2) Pick a world: use /world list or /world search to find a world ID.",
      "3) View a world: /world info world_id:<ID> (shows name, one-liner, rules, etc.).",
      "4) Join a world: /world join world_id:<ID> (joining grants you permission to talk).",
      "5) Set your active character in that world: /character act character_id:<ID> (run inside the world channels).",
      "",
      "Notes:",
      "- You can create multiple character cards and join multiple worlds.",
      "- You can publish your character card as public for others to search (/character publish).",
      "- If you lose this private onboarding thread: look for a private channel named like `onboarding-...` in the server sidebar, or run /onboard role:adventurer again.",
      "- In this onboarding thread, you can talk to the bot directly (no @ needed). In public channels, you may need to @mention the bot or use wake words.",
    ].join("\n"),
  );
}

export function buildDiscordWorldHelp(
  language: UserLanguage | null | undefined,
): string {
  return pick(
    language,
    [
      "世界系统指令：",
      "- /world create（默认仅管理员；可配置 world.createPolicy）",
      "  - 执行后会创建一个编辑话题：粘贴/上传设定原文，多轮补全；用 /world publish 发布世界并创建子空间",
      "- /world open world_id:<世界ID>（仅创作者；打开该世界的编辑话题）",
      "- /world publish [cover:<图片>]（仅创作者；在编辑话题中发布草稿世界，可附带 world-index 封面图）",
      "- /world export [world_id:<世界ID>]（仅创作者；导出世界卡/世界规则/正典文档）",
      "- /world import kind:world_card|rules|canon file:<文件> [world_id:<世界ID>]（仅创作者；上传并覆盖世界文档；kind=canon 会写入该世界正典库，如带 W<id>- 前缀会自动剥离）",
      "- /world image name:<名称> file:<图片> [world_id:<世界ID>]（仅创作者；上传图片并写入世界书素材区）",
      "- /world list [limit:<1-100>]",
      "- /world search query:<关键词> [limit:<1-50>]",
      "- /world info [world_id:<世界ID>]（在世界子空间频道内可省略 world_id）",
      "- /world rules [world_id:<世界ID>]（在世界子空间频道内可省略 world_id）",
      "- /world canon query:<关键词> [world_id:<世界ID>]（搜索该世界正典：世界卡/世界规则/正典补充；可在入口频道省略 world_id）",
      "- /world submit kind:<类型> title:<标题> content:<内容> [world_id:<世界ID>]（提案/任务/编年史/正典补充）",
      "- /world approve submission_id:<提交ID> [world_id:<世界ID>]（仅创作者；确认提案并写入 canon）",
      "- /world check query:<关键词> [world_id:<世界ID>]（冲突/检索：世界卡/世界规则/正典/提案）",
      "- /world join world_id:<世界ID> [character_id:<角色ID>]（加入世界获得发言权限；在世界子空间频道内可省略 world_id）",
      "- /world stats [world_id:<世界ID>]（或 /world status；在世界子空间频道内可省略 world_id）",
      "- /world remove world_id:<世界ID>（管理员）",
      "",
      "提示：",
      "- 所有人默认可查看世界子空间（只读）；加入后获得发言权限",
      "- 访客数=join 人数；角色数=该世界角色数（均持久化）",
    ].join("\n"),
    [
      "World commands:",
      "- /world create (admin-only by default; configurable via world.createPolicy)",
      "  - Creates an editing thread for pasting/uploading source lore; use /world publish to publish and create the world subspace",
      "- /world open world_id:<WORLD_ID> (creator only; open the editing thread)",
      "- /world publish [cover:<IMAGE>] (creator only; publish the draft world from the editing thread, optionally with a world-index cover image)",
      "- /world export [world_id:<WORLD_ID>] (creator only; export world card / world rules / canon docs)",
      "- /world import kind:world_card|rules|canon file:<FILE> [world_id:<WORLD_ID>] (creator only; overwrite world docs; kind=canon writes into the world's canon library and strips leading W<id>- if present)",
      "- /world image name:<NAME> file:<IMAGE> [world_id:<WORLD_ID>] (creator only; upload an image and append it into worldbook assets)",
      "- /world list [limit:<1-100>]",
      "- /world search query:<KEYWORD> [limit:<1-50>]",
      "- /world info [world_id:<WORLD_ID>] (world_id can be omitted inside world channels)",
      "- /world rules [world_id:<WORLD_ID>] (world_id can be omitted inside world channels)",
      "- /world canon query:<KEYWORD> [world_id:<WORLD_ID>] (search canon: world card / world rules / canon addenda; world_id can be omitted inside entry channels)",
      "- /world submit kind:<KIND> title:<TITLE> content:<CONTENT> [world_id:<WORLD_ID>] (proposal/task/chronicle/canon addendum)",
      "- /world approve submission_id:<SUBMISSION_ID> [world_id:<WORLD_ID>] (creator only; approve and write into canon)",
      "- /world check query:<KEYWORD> [world_id:<WORLD_ID>] (conflict/search: world card / world rules / canon / submissions)",
      "- /world join world_id:<WORLD_ID> [character_id:<CHARACTER_ID>] (join to gain talk permission; world_id can be omitted inside world channels)",
      "- /world stats [world_id:<WORLD_ID>] (or /world status; world_id can be omitted inside world channels)",
      "- /world remove world_id:<WORLD_ID> (admin)",
      "",
      "Notes:",
      "- Everyone can view world channels by default (read-only); joining grants talk permissions.",
      "- visitorCount = number of joined users; characterCount = number of world characters (both persisted).",
    ].join("\n"),
  );
}

export function buildDiscordCharacterHelp(
  language: UserLanguage | null | undefined,
): string {
  return pick(
    language,
    [
      "角色系统指令：",
      "- /character create [name:<角色名>] [visibility:public|private] [description:<补充>]",
      "  - 会创建一个编辑话题，多轮补全角色卡；默认 visibility=private",
      "- /character open character_id:<角色ID>（仅创作者；打开该角色的编辑话题）",
      "- /character export [character_id:<角色ID>]（仅创作者；导出角色卡；在编辑话题中可省略 character_id）",
      "- /character import file:<文件> [character_id:<角色ID>]（仅创作者；上传并覆盖角色卡；在编辑话题中可省略 character_id）",
      "- /character view character_id:<角色ID>（遵循 visibility 权限）",
      "- /character use character_id:<角色ID>（设置你的默认角色，全局）",
      "- /character act character_id:<角色ID>（在世界频道内执行：设置你在该世界的当前角色）",
      "- /character publish [character_id:<角色ID>]（设为 public）",
      "- /character unpublish [character_id:<角色ID>]（设为 private）",
      "- /character list [limit:<1-100>]（列出我的角色）",
      "- /character search query:<关键词> [limit:<1-50>]（搜索 public 角色）",
      "- /character adopt character_id:<角色ID> mode:copy|fork（把 public 角色变成你的角色）",
    ].join("\n"),
    [
      "Character commands:",
      "- /character create [name:<NAME>] [visibility:public|private] [description:<EXTRA>]",
      "  - Creates an editing thread for iterative character-card refinement; default visibility=private",
      "- /character open character_id:<CHARACTER_ID> (creator only; open the editing thread)",
      "- /character export [character_id:<CHARACTER_ID>] (creator only; export the character card; character_id can be omitted inside the editing thread)",
      "- /character import file:<FILE> [character_id:<CHARACTER_ID>] (creator only; upload and overwrite the character card; character_id can be omitted inside the editing thread)",
      "- /character view character_id:<CHARACTER_ID> (subject to visibility)",
      "- /character use character_id:<CHARACTER_ID> (set your global default character)",
      "- /character act character_id:<CHARACTER_ID> (run inside a world channel to set your active character in that world)",
      "- /character publish [character_id:<CHARACTER_ID>] (set to public)",
      "- /character unpublish [character_id:<CHARACTER_ID>] (set to private)",
      "- /character list [limit:<1-100>] (list my characters)",
      "- /character search query:<KEYWORD> [limit:<1-50>] (search public characters)",
      "- /character adopt character_id:<CHARACTER_ID> mode:copy|fork (turn a public character into yours)",
    ].join("\n"),
  );
}

export function buildDiscordWorldCreateGuide(input: {
  worldId: number;
  language: UserLanguage | null | undefined;
}): string {
  return pick(
    input.language,
    [
      `【世界创建指南】（W${input.worldId}）`,
      "",
      "1) 提供设定原文（任选其一）：",
      "   - 直接粘贴/分段发送（可多轮补全）",
      "   - 上传 txt/md/json/docx（会自动收录到“世界书：原始资料”）",
      "",
      "2) 系统会整理为两份正典（可反复修改）：",
      "   - 世界书：世界卡（世界背景/势力/地点/历史等）",
      "   - 世界书：规则（硬规则：初始金额/装备/底层逻辑/禁止事项等）",
      "",
      "3) 约定：已写入的内容视为正典；没写到的允许后续补全，但不要自相矛盾。",
      "",
      "4) 发布：确认已经 OK 后，在本话题执行 /world publish（或点击下方“发布”）。",
      "",
    ].join("\n"),
    [
      `[World Creation Guide] (W${input.worldId})`,
      "",
      "1) Provide the source setting material (choose one):",
      "   - Paste it directly (you can send in multiple messages)",
      "   - Upload txt/md/json/docx (will be added to “Worldbook: Source”)",
      "",
      "2) The system will normalize it into two canonical documents (iterative edits allowed):",
      "   - Worldbook: World Card (background / factions / locations / history, etc.)",
      "   - Worldbook: Rules (starting money/equipment/core logic/prohibitions, etc.)",
      "",
      "3) Convention: written content is canon; missing parts can be filled later, but do not contradict established canon.",
      "",
      "4) Publish: when everything is OK, run /world publish in this thread (or click “Publish” below).",
      "",
    ].join("\n"),
  );
}

export function buildDiscordCharacterCreateGuide(input: {
  characterId: number;
  language: UserLanguage | null | undefined;
}): string {
  return pick(
    input.language,
    [
      `【角色卡创建指南】（C${input.characterId}）`,
      "",
      "1) 提供角色设定原文（任选其一）：",
      "   - 直接粘贴/分段发送（可多轮补全）",
      "   - 上传 txt/md/json/docx（会自动收录到“角色图书馆：原始资料”）",
      "",
      "2) 系统会整理为角色卡正典（可反复修改）：",
      "   - 角色卡：角色信息/外貌/性格/背景/关系/能力/底线等",
      "",
      "3) 本话题会长期保留以供后续继续修改；完成后可执行 /character publish 设为 public。",
      "",
    ].join("\n"),
    [
      `[Character Card Guide] (C${input.characterId})`,
      "",
      "1) Provide the character source material (choose one):",
      "   - Paste it directly (you can send in multiple messages)",
      "   - Upload txt/md/json/docx (will be added to “Character Library: Source”)",
      "",
      "2) The system will normalize it into canonical output (iterative edits allowed):",
      "   - Character Card: identity/appearance/personality/background/relations/abilities/boundaries, etc.",
      "",
      "3) This thread is persistent; when it's ready, run /character publish to make it public.",
      "",
    ].join("\n"),
  );
}

export function buildDiscordWorldBuildKickoff(input: {
  worldId: number;
  worldName: string;
  language: UserLanguage | null | undefined;
}): string {
  return pick(
    input.language,
    [
      "你现在在世界构建/编辑模式。",
      "请执行技能 world-design-card：读取「世界书：原始资料」，并更新「世界书：世界卡」与「世界书：规则」。",
      "回复仅保留：变更摘要 +（如信息不足）3-5 个待补充问题；信息充分时明确写“已 OK，可发布”。",
      "对创作者回复禁止暴露任何路径/文件名；统一使用“世界书/角色卡”等产品术语。",
      "完成后请提醒创作者在本话题执行 /world publish。",
      "",
      `世界：W${input.worldId} ${input.worldName}`,
    ].join("\n"),
    [
      "You are now in world build/edit mode.",
      "Run skill world-design-card: read “Worldbook: Source”, then update “Worldbook: World Card” and “Worldbook: Rules”.",
      "Reply with only: change summary + (if missing info) 3–5 follow-up questions; if sufficient, clearly say “OK to publish”.",
      "Never expose paths or filenames in creator-facing replies; use product terms like Worldbook / Character Card.",
      "After finishing, remind the creator to run /world publish in this thread.",
      "",
      `World: W${input.worldId} ${input.worldName}`,
    ].join("\n"),
  );
}

export function buildDiscordWorldBuildAutopilot(input: {
  worldId: number;
  worldName: string;
  language: UserLanguage | null | undefined;
}): string {
  return pick(
    input.language,
    [
      "自动推进：请继续按技能 world-design-card 处理当前「世界书：原始资料」，并更新世界卡与规则。",
      "能确定的先写，不确定的请标注并在末尾列出 3-5 个待确认问题。",
      "不要 roleplay，不要编造未提供设定；不要使用交互式 question 工具。",
      "",
      `世界：W${input.worldId} ${input.worldName}`,
    ].join("\n"),
    [
      "Autopilot: continue with skill world-design-card on current “Worldbook: Source”, and update world card/rules.",
      "Write confirmed parts first; mark uncertainties and list 3–5 follow-up questions at the end.",
      "Do not roleplay, do not invent details, and do not use interactive question tools.",
      "",
      `World: W${input.worldId} ${input.worldName}`,
    ].join("\n"),
  );
}

export function buildDiscordCharacterBuildAutopilot(input: {
  characterId: number;
  characterName: string;
  language: UserLanguage | null | undefined;
}): string {
  return pick(
    input.language,
    [
      "自动推进：请继续按技能 character-card 处理当前「角色图书馆：原始资料」，并更新「角色卡」。",
      "能确定的先写，不确定的请标注并在末尾列出 3-5 个待确认问题。",
      "不要 roleplay，不要编造未提供设定；不要使用交互式 question 工具。",
      "",
      `角色：C${input.characterId} ${input.characterName}`,
    ].join("\n"),
    [
      "Autopilot: continue with skill character-card on current “Character Library: Source”, and update “Character Card”.",
      "Write confirmed parts first; mark uncertainties and list 3–5 follow-up questions at the end.",
      "Do not roleplay, do not invent details, and do not use interactive question tools.",
      "",
      `Character: C${input.characterId} ${input.characterName}`,
    ].join("\n"),
  );
}

export function buildDiscordCharacterPortraitGenerate(input: {
  characterId: number;
  characterName: string;
  language: UserLanguage | null | undefined;
}): string {
  return pick(
    input.language,
    [
      "请为当前角色生成 1 张角色立绘。",
      "",
      "必须要求：",
      "1) 必须调用 banana 生图相关技能，优先 TalesOfAI MCP 的 make image / edit image；禁止编造图片链接。",
      "2) 若当前会话已存在角色卡，请优先读取并严格按角色卡绘制。",
      "3) 只输出最终图片（Markdown 图片语法），不要长篇解释。",
      "",
      `角色：C${input.characterId} ${input.characterName}`,
    ].join("\n"),
    [
      "Generate one portrait image for the current character.",
      "",
      "Requirements:",
      "1) Must use banana image-generation skills, preferring TalesOfAI MCP make-image / edit-image tools; never fabricate image URLs.",
      "2) If a character card exists in this session, read it first and follow it closely.",
      "3) Output only the final image (Markdown image syntax), no long explanation.",
      "",
      `Character: C${input.characterId} ${input.characterName}`,
    ].join("\n"),
  );
}

export function buildDiscordCharacterPortraitGenerateWithReference(input: {
  characterId: number;
  characterName: string;
  language: UserLanguage | null | undefined;
}): string {
  return pick(
    input.language,
    [
      "请为当前角色生成 1 张角色立绘（参考图模式）。",
      "",
      "必须要求：",
      "1) 必须调用 banana 改图/生图技能，优先 TalesOfAI MCP 的 edit image；禁止编造图片链接。",
      "2) 若当前消息或近期消息没有参考图，请先明确向用户要参考图后再生成。",
      "3) 若会话内存在角色卡，需同时遵循角色卡设定与参考图关键信息。",
      "4) 只输出最终图片（Markdown 图片语法），不要长篇解释。",
      "",
      `角色：C${input.characterId} ${input.characterName}`,
    ].join("\n"),
    [
      "Generate one portrait image for the current character (reference-image mode).",
      "",
      "Requirements:",
      "1) Must use banana image edit/generation skills, preferring TalesOfAI MCP edit-image; never fabricate image URLs.",
      "2) If there is no reference image in current/recent messages, explicitly ask the user for one before generating.",
      "3) If a character card exists, follow both the card and the key visual cues from the reference image.",
      "4) Output only the final image (Markdown image syntax), no long explanation.",
      "",
      `Character: C${input.characterId} ${input.characterName}`,
    ].join("\n"),
  );
}

export function buildDiscordCharacterBuildKickoff(input: {
  characterId: number;
  characterName: string;
  language: UserLanguage | null | undefined;
}): string {
  return pick(
    input.language,
    [
      "你现在在角色卡构建模式。",
      "请执行技能 character-card：读取「角色图书馆：原始资料」，并更新「角色卡」。",
      "回复仅保留：变更摘要 +（如信息不足）3-5 个待补充问题；信息充分时明确写“已 OK”。",
      "不要使用交互式 question 工具；需要补充信息请直接文字提问。",
      "",
      `角色：C${input.characterId} ${input.characterName}`,
    ].join("\n"),
    [
      "You are now in character-card build mode.",
      "Run skill character-card: read “Character Library: Source”, then update “Character Card”.",
      "Reply with only: change summary + (if missing info) 3–5 follow-up questions; if sufficient, clearly say “OK”.",
      "Do not use interactive question tools; ask follow-up questions directly in plain text.",
      "",
      `Character: C${input.characterId} ${input.characterName}`,
    ].join("\n"),
  );
}

export function buildDiscordWorldCharacterBuildKickoff(input: {
  worldId: number;
  worldName: string;
  characterId: number;
  characterName: string;
  language: UserLanguage | null | undefined;
}): string {
  return pick(
    input.language,
    [
      "你现在在“世界专用角色卡修正”模式。",
      "请按技能 character-card 进行世界适配：读取「世界书：世界卡」「世界书：规则」（只读），只更新「角色卡」。",
      "不要修改世界书文件；即使修改也不会保存。",
      "回复仅保留：变更摘要 +（如信息不足）3-5 个待补充问题；信息充分时明确写“已 OK”。",
      "你不是来写小说的，不要 roleplay，不要替用户发言。",
      "",
      `世界：W${input.worldId} ${input.worldName}`,
      `角色：C${input.characterId} ${input.characterName}`,
    ].join("\n"),
    [
      "You are now in world-specific character card correction mode.",
      "Use skill character-card for world adaptation: read “Worldbook: World Card” and “Worldbook: Rules” (read-only), and update only “Character Card”.",
      "Do not modify world files; even if you do, changes will not be saved.",
      "Reply with only: change summary + (if missing info) 3–5 follow-up questions; if sufficient, clearly say “OK”.",
      "You are not here to write a novel; do not roleplay or speak on behalf of the user.",
      "",
      `World: W${input.worldId} ${input.worldName}`,
      `Character: C${input.characterId} ${input.characterName}`,
    ].join("\n"),
  );
}
