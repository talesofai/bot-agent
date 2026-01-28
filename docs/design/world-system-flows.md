# 世界系统流程（Discord Only）

> 目标：把每条指令的**输入→校验→副作用→输出**写清楚，并列出失败分支。  
> 相关：总体设计 `docs/design/world-system.md`，版本计划 `docs/plans/0.0.30.md`。

## 0. 全局不变式（别让实现到处开洞）

### 0.1 世界是全局的，但入口是单点的

- 世界 `worldId` 全局唯一（数字自增）。
- 每个世界只有一个入口服务器：`homeGuildId`。
- 世界子空间（category + channels + role）只存在于 `homeGuildId` 对应的 guild。

### 0.2 “能看到但不能进入”的定义（落地到 Discord 权限）

- **能看到**：所有人可以执行只读指令（`/world info|rules|stats|list|canon`），并且在 `homeGuild` 内 `#world-info` 对 @everyone 可读。
- **不能进入**：未加入（未 `/world join`）的人无法在 `#world-roleplay/#world-proposals/Voice` 发言/提案/连接（由 World Role + channel overwrites 强制）。

### 0.3 未加入世界时：bot 必须响应

- 对只读指令：正常返回。
- 对写入类指令：明确拒绝 + 引导去该世界的 `#world-join` 频道执行 `/world join`（不需要 worldId）。
- `/world join` 在非 `homeGuild` 执行：明确提示“入口在 homeGuild，需要加入该服务器后再 join”，不要“半加入”。

### 0.4 会话隔离（世界=虚拟 groupId）

- 世界频道消息路由到 `groupId = world_{worldId}`。
- 其他频道仍使用 `groupId = guildId`。
- world roleplay 频道必须 **always-on**（不依赖 mention/keyword）。

### 0.5 计数口径（必须稳定）

- `访客数 = SCARD(world:{id}:members)`（join 人数）
- `角色数 = SCARD(world:{id}:characters)`（世界下角色数）

---

## 1. `/world create`（创建世界）

### 输入

- 触发：slash command `/world create`
- 参数：无（不需要世界名/摘要；允许空输入）
- 后续输入：在自动创建的私密话题中，创作者通过多轮对话补全信息（可直接发文字，也可上传 txt/md/docx）

### 前置条件

- 必须在 guild 内执行（不能 DM）。
- 权限满足 `world.createPolicy`（默认 `admin`）：
  - `admin`：Discord 管理员或群配置 `adminUsers`
  - `whitelist`：在 `createWhitelist`
  - `open`：任意成员

### 主流程

1. 校验权限（`world.createPolicy`）。
2. 分配 `worldId = INCR(world:next_id)`，写入 Redis `world:{worldId}:meta`（`status=draft`；此时不进入 `/world list|search` 索引）。
3. 初始化文件（文件系统持久化）：
   - `/data/worlds/{worldId}/world-card.md`（初稿）
   - `/data/worlds/{worldId}/rules.md`（初稿）
   - `/data/worlds/{worldId}/source.md`（设定原文最新版本；历史副本在 `sources/`）
   - `/data/worlds/{worldId}/events.jsonl`（append：world_draft_created / world_source_uploaded）
4. 创建“世界构建私密会话”：
   - 优先：在当前频道下创建 PrivateThread（仅创作者可见）
   - 失败降级：创建 creator-only 临时频道
   - 写入路由：`channel:{buildConversationChannelId}:group = world_{worldId}_build`（构建会话 always-on）
5. 在私密会话中触发 kickoff：
   - AI 必须读取 `world/source.md`
   - AI 必须写入 `world/world-card.md` 与 `world/rules.md`
   - 回复只包含：变更摘要 + 3-5 个待补充问题（或明确“已 OK，可发布”）
6. 对执行者返回成功（ephemeral）并附私密话题链接；创作者在该话题执行 `/world done` 发布世界。

### 失败分支（必须明确）

- bot 缺少 `Manage Roles/Channels`：返回“权限不足”并停止（不要创建半套资源）。
- 私密话题创建失败：返回错误并提示“请联系管理员”；允许留下 `status=draft` 供后续手工修复/清理。
- 写入 Redis/文件失败：提示“持久化失败”，不要继续创建更多资源。

---

## 1.1 `/world done`（发布世界 / 结束编辑话题）

### 前置条件

- 必须在世界构建/编辑私密话题内执行（该频道已被映射到 `groupId=world_{id}_build`）。
- 仅世界创作者可执行。

### 主流程

1. 从当前频道推断 `worldId`（通过 `channel:{channelId}:group` 或 category/world 映射）。
2. 读取 `world:{id}:meta`：
   - 若 `status=draft`：执行发布
   - 否则：仅结束当前话题（archive+lock）
3. 发布（仅 `draft`）：
   - 创建 Discord 子空间：Role + Category + Channels（`world-info/world-join/world-roleplay/world-proposals/voice/world-build`）
   - 写入 `world:{id}:meta`（`status=active`，补齐 roleId/categoryId/channelIds，并写入索引）
   - 自动拉创作者加入：赋 role + `SADD(world:{id}:members, creatorId)`（访客数口径）
   - `channel:{roleplayChannelId}:world = worldId`（兼容推断）与 always-on 路由
4. 结束话题：归档/锁定 thread（如果是 thread）；并返回结果（包含 join 入口与 roleplay 入口）。

### 失败分支

- 当前频道无法推断世界：返回“当前频道不属于世界构建会话”。
- bot 无法创建子空间资源：返回错误并保持 `draft`，避免发布半残世界。

---

## 1.2 `/world edit <worldId>`（创建世界编辑话题）

### 主流程

1. 校验 world 存在且执行者是创作者。
2. 创建编辑私密话题（优先 thread；失败降级 creator-only 临时频道），并映射到 `groupId=world_{id}_build`。
3. 触发 kickoff（同 `/world create`）。

---

## 2. `/world list`（世界列表，全局可读）

### 主流程

1. 读取世界索引（例如 `SMEMBERS(world:ids)` 或 `ZRANGE(world:created_at, ...)`）。
2. 批量读取 `world:{id}:meta`，过滤 `status != active`（如果有）。
3. 返回列表（包含 worldId、名称、homeGuildId、访客数/角色数摘要可选）。

### 失败分支

- 索引为空：返回“暂无世界”。

---

## 3. `/world info <worldId>`（查看世界卡）

### 主流程

1. 校验 `worldId` 存在（`world:{id}:meta`）。
2. 读取 `/data/worlds/{id}/world-card.md`（或缓存）。
3. 返回：
   - 世界名、简介
   - `homeGuildId`（入口说明：只能在入口服务器进入）
   - 相关频道（如果当前 guild 是 homeGuild 且能解析 channel）

### 失败分支

- 世界不存在：返回“worldId 不存在”。
- 文件缺失：返回“世界卡缺失（待修复）”并提示管理员。

---

## 4. `/world rules <worldId>`（查看规则）

同 `/world info`，但读取 `rules.md`。

---

## 5. `/world join`（加入世界，仅在 world-join 执行）

### 前置条件

- 用户必须在该世界的 `homeGuild` 内执行此命令（否则无法赋 role）。
- 必须在该世界子空间的 `#world-join` 频道内执行（不需要 worldId）。

### 主流程

1. 从当前频道推断 `worldId`（category/world 映射或 joinChannelId 比对）。
2. 校验当前频道确实是该世界的 join 入口：
   - 否则返回：请到 `<#world-join>` 执行 `/world join`。
3. 给用户赋予 world role。
4. `SADD(world:{id}:members, userId)`（幂等，访客数口径）。
5. append `events.jsonl`：world_joined。
6. 返回成功（提示 roleplay 入口频道）。

### 失败分支

- bot 无法赋 role：返回“bot 权限不足（无法分配角色）”。

---

## 6. `/world stats <worldId>`（统计，全局可读）

### 主流程

1. 校验 world 存在。
2. 读取：
   - `SCARD(world:{id}:members)` → 访客数
   - `SCARD(world:{id}:characters)` → 角色数
3. 可选：读取 `events.jsonl` 最近 N 条（用于“时间变化”）。
4. 返回统计摘要。

---

## 7. `/character create`（创建角色卡）

### 前置条件

- 必须指定目标世界（建议 slash option：`worldId`；或在世界频道内自动推断）。
- 用户必须是该世界成员（`SISMEMBER(world:{id}:members, userId)`）。

### 主流程

1. 解析 world 上下文：
   - 如果在 world 频道：由 `channel:{channelId}:world` 推断 `worldId`
   - 否则要求参数 `worldId`
2. 校验成员资格；未加入则拒绝并提示去该世界的 `#world-join` 执行 `/world join`。
3. 分配 `characterId = INCR(character:next_id)`。
4. 写入 `character:{characterId}:meta`：
   - `worldId creatorId name visibility=world status=active createdAt updatedAt`
5. 将角色加入世界集合：`SADD(world:{worldId}:characters, characterId)`。
6. 落地角色卡文件：`/data/worlds/{worldId}/characters/{characterId}.md`。
7. append `events.jsonl`：character_created。
8. 返回创建结果（提供 `/character view {id}` 与 `/character act {id}`）。

### 失败分支

- 文件写入失败：返回“角色卡落地失败”，并回滚 Redis 或标记为 `status=failed`（实现阶段决定）。

---

## 8. `/character view ...`（查看角色卡）

### 主流程

1. 解析目标角色（`characterId` 或 `@用户` → 需要有索引支持，否则先只支持 `characterId`）。
2. 读取 `character:{id}:meta` 与角色卡文件。
3. 可见性校验：
   - `public`：直接返回
   - `world`：要求 `SISMEMBER(world:{worldId}:members, requesterId)`
   - `private`：要求 `requesterId == creatorId`
4. 返回角色卡内容。

---

## 9. `/character act <characterId>`（设置用户当前角色）

### 主流程

1. 校验角色存在且属于某个 world。
2. 校验请求者是该世界成员（至少 `visibility != public` 时必须是成员；推荐统一要求成员）。
3. 写入状态：`SET(world:{worldId}:active_character:{userId}, characterId)`。
4. 返回确认：后续用户在 `#world-roleplay` 的发言将视为该角色的行动/台词；bot 作为旁白/世界系统回应（由 world readonly skill + system prompt 实现）。

---

## 10. `/submit`、`/chronicle add`、`/check`（正典最小闭环）

### `/submit <type> <content>`

- 前置：建议要求成员资格（至少 world 内提案）。
- 流程：落地 draft（Redis 或文件）→ 记录事件 → 在 `#world-proposals` 通知创作者。

### `/chronicle add <event>`

- 权限：仅世界创作者/管理员。
- 流程：写入世界编年史（文件）→ 记录事件 → 可选同步一条到 `#world-info`。

### `/check <设定>`

- 流程：检索正典（文件/索引）→ 输出冲突点与建议修正。
- 说明：这是 opencode 擅长的“总结”，但最终写入仍由 bot 代码做。

---

## 11. `/map generate`、`/map update`（banana）

本阶段重点不是“画得多好”，而是**调用协议、落地点、版本**固定下来。

- `generate`：写入 `/data/worlds/{worldId}/map/`（图片 + 元数据）
- `update`：新版本写入并在 `events.jsonl` 记录变化

---

## 12. 消息路由流程（world roleplay）

### 输入

- Discord 普通消息（非 slash command）

### 主流程

1. 读取 `channelId`。
2. 若 `channel:{channelId}:world` 存在：
   - 取 `worldId`
   - 重写 `groupId = world_{worldId}`
   - 对 world roleplay channel 强制入队（always-on）
3. 否则按现有逻辑：`groupId = guildId`，触发规则照旧（mention/keyword）。

### 权限边界

- 频道权限已阻止未 join 用户发言；仍需在命令层做 membership 校验（防“跨频道调用”绕过）。
