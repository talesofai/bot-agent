---
title: Discord 世界系统（World + Character）实现计划
status: active
---

# 目标（Goal）

在单一 Discord `homeGuild` 内提供“世界（World）/角色卡（Character Card）”两套创作与游玩能力：

- 世界：所有人可见（可读），未加入（join）不可发言；加入后获得发言权限；统计必须有 **访客数** 与 **角色数**，并可持久化。
- 角色：用户创建“角色卡”（人设），并在世界内以该角色身份发言；**用户扮演，bot 作为旁白/世界系统回应**。
- 世界/角色的创作与更新：在“私密对话”中进行（DM 优先，失败则创建创作者专属频道作为兜底），会话长期存在，不需要关闭。

# 约束（Constraints）

- 只做 Discord（`LLBOT_PLATFORM=discord`），不做 QQ 默认启动。
- 上下文只依赖 opencode session；不再依赖 Postgres history（避免复杂性与不必要耦合）。
- 世界/角色的“正典文件”必须落盘到本地文件系统（`/data`），由 opencode 通过工具写入/修改。
- 飞书日志：只要 `warn+` 与所有收发消息/指令/AI 开始结束，且必须是可读事件文本（非大坨 JSON）。

# 核心数据结构（Data Model）

## World（世界）

- `worldId`: Redis 自增数字。
- `WorldMeta`（Redis Hash）：`draft|active`，包含创作者、homeGuild、发布后 Discord 资源（roleId/categoryId/各频道 id）。
- `members`（Redis Set）：`world:{id}:members` → 访客数（join 人数）。
- `worldCharacters`（Redis Set）：`world:{id}:characters` → 角色数（进入/使用过的角色集合）。

文件落盘（FileStore）：

- `/data/worlds/{worldId}/world-card.md`（世界卡，正典）
- `/data/worlds/{worldId}/rules.md`（世界规则，正典）
- `/data/worlds/{worldId}/source.md`（创作者上传/粘贴的设定原文，构建态可见）
- `/data/worlds/{worldId}/events.jsonl`（事件流，便于审计/追踪）

## Character（角色卡）

- `characterId`: Redis 自增数字。
- `CharacterMeta`（Redis Hash）：creatorId/name/visibility(`private|public`)/status。

文件落盘：

- `/data/characters/{characterId}.md`（角色卡正文本体）
- `/data/characters/{characterId}.events.jsonl`（事件流）

# Discord 结构（频道/权限）

每个世界发布后创建一个 Category：`[W{worldId}] {worldName}`，包含：

- `world-announcements`：公告区（世界背景/正典快照放这里）；默认只读，创作者+bot 可发。
- `world-discussion`：讨论区（游玩/问答/任务等）；未 join 只读，join 后可发言。
- `world-proposals`：玩家提案区（提案/正典提案等）；未 join 只读，join 后可发言。
- `World Voice`：语音（join 后可进入）。

权限策略（核心原则）：

- `@everyone`：可 `ViewChannel` + `ReadMessageHistory`（可见可读），禁止 `SendMessages`（只读）。
- `World Role`：在 discussion/proposals/voice 可发言/加入语音；在 announcements 只读（避免刷屏）。
- `UseApplicationCommands` 对 `@everyone` 开启：即使只读也能执行 `/world join` 完成加入。

# 工作流（Flows）

## 1) 世界创建（创作者）

1. 在 `homeGuild` 执行 `/world create`（默认仅管理员；由 `world.createPolicy` 控制）。
2. 系统创建 `draft` 世界（分配 `worldId`），并生成默认文件：`world/world-card.md`、`world/rules.md`、`world/source.md`（占位）。
3. 自动打开“私密对话”（DM 优先；失败则创建 `world-workshop-{userId}` 仅创作者可见频道）并绑定到 `groupId=world_{worldId}_build`。
4. 在私密对话中：
   - 先发送规则说明（可读）
   - 然后触发 kickoff（让 opencode 使用 `world-design-card` 技能写入/更新 `world/world-card.md` 与 `world/rules.md`）
5. 创作者通过多轮对话/上传 txt/md/docx 原文补全信息（写入 `world/source.md`）。
6. 创作者确认完成后，在私密对话执行 `/world publish`：
   - 创建子空间（Category + channels + role）
   - 自动把创作者加入世界（加 role + 计入 members）
   - 推送“世界信息快照”（世界卡 + 规则）到 `world-announcements`

## 2) 世界加入（玩家）

1. 玩家在世界子空间任一频道执行 `/world join`（无需 worldId）。
2. 系统给玩家加 World Role，并把玩家计入 `members`（访客数）。
3. 选择“当前角色”：
   - 若玩家显式提供 `character_id` → 作为当前角色
   - 否则使用全局默认角色（`/character use`）
   - 若玩家没有任何角色卡 → 提示先 `/character create`

## 3) 游玩对话（世界内）

- `world-discussion/world-proposals` 的消息会路由到 `groupId=world_{worldId}`（play）。
- `world_{worldId}` 会话工作区注入只读文件：
  - `world/world-card.md`
  - `world/rules.md`
  - `world/active-character.md`（若用户已在该世界设置当前角色）
- 只读会话禁止写入世界/角色文件：防止非创作者“意外改正典”。

## 4) 角色卡创建/管理（用户）

1. 执行 `/character create`（默认 visibility=private），创建角色卡与默认内容。
2. 自动进入私密对话（DM 优先，失败则 `character-workshop-{userId}`），绑定 `groupId=character_{id}_build`。
3. opencode 使用 `character-card` 技能写入 `character/character-card.md`。
4. 可用命令：
   - `/character use`：设置全局默认角色
   - `/character act`：在世界频道内设置该世界的当前角色
   - `/character publish|unpublish`：切换 public/private（public 才能被 search）

# 指令清单（Commands）

## /world

- `/world help`
- `/world create`（默认 admin）
- `/world open world_id:<ID>`（仅创作者；打开/切换私密编辑会话）
- `/world publish`（仅创作者；在私密对话执行）
- `/world list`
- `/world search`
- `/world info`（世界子空间内可省略 world_id）
- `/world rules`（世界子空间内可省略 world_id）
- `/world canon`
- `/world join`（在世界子空间内执行）
- `/world stats` / `/world status`
- `/world remove world_id:<ID>`（管理员）

## /character

- `/character help`
- `/character create`
- `/character open`
- `/character view`
- `/character use`
- `/character act`（世界内）
- `/character publish` / `/character unpublish`
- `/character list`
- `/character search`

# 日志（Feishu）

飞书 webhook 仅推送：

- `log.warn` / `log.error`
- `io.recv` / `io.send`（用户与 bot 的收发预览）
- `discord.command.start` / `discord.command.reply`
- `ai.start` / `ai.finish`（含输出预览）

# TODO（后续迭代）

- 世界任务系统：世界通用任务 / 剧本 / 世界新闻（从 `world-proposals` 或后台配置触发）。
- 正典系统：玩家提案 → 初审核 → 创作者确认 → 写入世界历史（chronicle）。
- 世界地图：`/map generate`（banana 生成）与 `/map update`（按剧情改图），并把图/说明落盘与公告。
- 数据面板：`/world stats` 扩展（访客趋势、角色数趋势、浏览数等），并在 Web UI 可视化。
- Onboarding：新用户加入 homeGuild 后引导阅读规则 → 创建角色卡 → 选择世界进入。
