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
- 对写入类指令：**明确拒绝 + 引导 `/world join <id>`**。
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
- 允许附带：世界名、设定文档/描述（可选）

### 前置条件

- 必须在 guild 内执行（不能 DM）。
- 权限满足 `world.createPolicy`（默认 `admin`）：
  - `admin`：Discord 管理员或群配置 `adminUsers`
  - `whitelist`：在 `createWhitelist`
  - `open`：任意成员

### 主流程

1. 校验权限与参数（世界名非空，长度限制）。
2. 分配 `worldId = INCR(world:next_id)`，并写入全局索引（例如 `SADD(world:ids, worldId)` + `ZADD(world:created_at, ts, worldId)`）。
3. 创建 Discord Role：`World-{worldId}`。
4. 创建 category：`[W{worldId}] {worldName}`。
5. 创建频道：
   - `#world-info`（@everyone 可读；不可写/可写按需）
   - `#world-roleplay`（@everyone 只读；world role 可写）
   - `#world-proposals`（@everyone 只读；world role 可写）
   - `World Voice`（@everyone 可连/不可连按需；world role 可连）
6. 写入 Redis `world:{worldId}:meta`（包含 `homeGuildId`、channelIds、roleId、creatorId、name、timestamps）。
7. 写入路由映射 `channel:{channelId}:world = worldId`（至少包括 roleplay/proposals/info/voice）。
8. 自动加入创作者：
   - `SADD(world:{worldId}:members, creatorId)`
   - 给创作者赋予 world role
9. 初始化文件：
   - `/data/worlds/{worldId}/world-card.md`
   - `/data/worlds/{worldId}/rules.md`
   - `/data/worlds/{worldId}/events.jsonl`（append：world_created）
10. 在 `#world-info` 发布世界入口信息（世界简介、规则链接、join 指令、统计入口）。
11. 对执行者返回成功（优先 ephemeral，避免刷屏）。

### 失败分支（必须明确）

- bot 缺少 `Manage Roles/Channels`：返回“权限不足”并停止（不要创建半套资源）。
- Discord 资源创建中途失败：至少保证 meta 里标记 `status=failed`，并提示管理员手工清理；后续可补 `/world repair`。
- 写入 Redis/文件失败：提示“持久化失败”，不要继续创建更多资源。

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

## 5. `/world join <worldId>`（加入世界）

### 前置条件

- 用户必须在该世界的 `homeGuild` 内执行此命令（否则无法赋 role）。

### 主流程

1. 校验 world 存在。
2. 校验当前 guildId == `homeGuildId`：
   - 否则返回：入口在 `homeGuildId`，请先加入该服务器。
3. `SADD(world:{id}:members, userId)`（幂等）。
4. 给用户赋予 world role。
5. append `events.jsonl`：world_joined。
6. 返回成功（可提示“已获得进入权限，可以在 #world-roleplay 发言”）。

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
2. 校验成员资格；未加入则拒绝并提示 `/world join <id>`。
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

## 9. `/character act <characterId>`（指定 bot 扮演角色）

### 主流程

1. 校验角色存在且属于某个 world。
2. 校验请求者是该世界成员（至少 `visibility != public` 时必须是成员；推荐统一要求成员）。
3. 写入状态：`SET(world:{worldId}:active_character:{userId}, characterId)`。
4. 返回确认：后续在 `#world-roleplay` 的对话以该角色身份进行（由 world readonly skill + system prompt 实现）。

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
