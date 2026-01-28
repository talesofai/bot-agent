# 世界/角色系统设计（Discord Only）

> 目的：把“世界观创建者/角色系统/正典/任务/统计/子空间”需求做一次**彻底调研**，并把后续要做的事情与关键设计思路落成文档。  
> 状态：设计已落地 MVP，实现以代码与 `CHANGELOG.md` 为准。

相关文档：

- 版本计划：`docs/plans/0.0.30.md`
- 指令流程：`docs/design/world-system-flows.md`

## 1. 需求理解确认（请校对）

根据目前对话，我理解你的硬约束是：

1. **只做 Discord**（不考虑 QQ 适配）。
2. **上下文/记忆只用 opencode session**：不再依赖 PostgreSQL 历史；PG 相关逻辑应被停用/注释（现已倾向 Noop history）。
3. **世界全局共享**：`/world list`/`/world info` 不按 guild 分库；并先固定 **单 `homeGuild`**（世界子空间只存在于创建它的 guild）。
4. 世界发布后自动生成 Discord “子空间”（category + 若干频道）；作者自动加入；其他人必须在该世界的 `#world-join` 频道执行 `/world join` 才能“进入”游玩。
5. “能看到，只是不能进入”：所有人可查看世界卡与规则、可看世界进度；未 join 的人不能在世界子空间的入口频道发言/提案/游玩（用 World Role 做权限），但 bot 会对未 join 的世界相关操作**给出明确响应**（拒绝/引导 join），而不是装死。
6. **计数必须有且可持久化**：
   - **访客数**：用 join 人数（members）定义即可。
   - **角色数**：这个世界下登记的角色数量（characters）。
7. **世界ID/角色ID**：都必须是**数字自增**。
8. “角色”不是用户本人 RP；而是用户创建一个人设在该世界生活；**roleplay = 用户以该角色身份发言，bot 作为旁白/世界系统回应**。
9. 世界信息在子空间聊天时应可只读获取（skill），且该子空间的对话是**新的 session**，不带外部记忆。

如果上述有任何偏差，你直接指出哪条错了，我会改设计，而不是加 if。

---

## 2. 核心判断（Linus 风格）

**核心判断：** 值得做。  
原因：这是明确的产品需求（“想创造自己的世界”“可视化结构”“动态变化”“统计影响力”），而且可以用**很少的、明确的数据结构**把它做出来。

**关键洞察：**

- **数据结构：** 核心不是“世界卡长什么样”，而是 `worldId` 与 `channelId`、`member(userId)`、`characterId` 的关系。把这套关系做对，后面功能都是堆数据，不是堆分支。
- **复杂性：** Discord 的“看得到但不能进”如果靠频道 overwrites 给每个人打补丁，会把系统做成垃圾。要么只做 bot 层准入（最简单），要么用“世界角色(role) + 少量覆盖”解决。
- **最大风险点：** **路由**。现有代码 `groupId = guildId`，这会导致所有世界共享同一个 session。必须引入 `channelId → worldId` 映射，并在 dispatch 阶段重写 groupId（否则你得到的是一个“所有世界共享记忆”的怪物）。

---

## 3. 现状调研（基于当前仓库）

### 3.1 会话与路由现状

- `resolveDispatchGroupId()` 当前逻辑：有 `guildId` 就用 `guildId` 作为 `groupId`；否则 DM 为 `"0"`。
- 会话目录键：`/data/groups/sessions/{botId}/{groupId}/{userId}/{sessionId}`（因此 `groupId` 变化 = session 隔离）。
- 群上下文与 skills 注入依赖 `groupId`（`/data/groups/{groupId}` + `configs/skills`）。

结论：要做“世界子空间独立 session”，最便宜的做法就是把世界频道映射成一个“虚拟 groupId”。

### 3.2 Trigger 机制的坑

现有 `shouldEnqueue()`：群里只有满足以下之一才会入队：

- mention 了 bot
- 或命中 keywords（默认可能为空）

这意味着：如果你希望在 `#world-roleplay` 里“随便说话 bot 都接”，必须引入 **世界频道 always-on** 的特殊规则，否则用户体验会直接烂掉。

### 3.3 PG 历史

你明确要求“不需要 PG”。当前方向是：

- HistoryStore 默认 Noop（不再注入跨群/跨世界历史）。
- 世界相关数据与统计走 Redis + 文件落地（见后文）。

---

## 4. 数据模型（先关心数据结构，不要关心 UI）

### 4.1 核心实体

**World（世界）**

- `id: number`（自增）
- `homeGuildId: string`（世界“入口/子空间”所在的 guild）
- `creatorId: string`
- `name: string`
- `status: "active" | "archived"`（先留着，别加复杂）
- `createdAt/updatedAt: string(ISO)`
- Discord 结构：
  - `categoryId: string`
  - `infoChannelId: string`
  - `roleplayChannelId: string`
  - `proposalsChannelId: string`
  - `voiceChannelId: string`
  - （可选）`roleId: string`（用 role 实现准入）

**WorldContent（世界内容，文件系统为主）**

- `world-card.md`（世界卡：来自 world-design-card skill 输出）
- `rules.md`（世界底层规则：例如初始金钱、初始装备、遇水即融等）
- `map/`（banana 产物：图片/描述/版本）
- `events.jsonl`（世界事件流：join、创建角色、正典更新等，用于“时间变化”展示）

**Character（角色）**

- `id: number`（自增）
- `worldId: number`
- `creatorId: string`（谁创建的这个角色卡）
- `name: string`
- `visibility: "world" | "public" | "private"`（可见性，默认 `world`）
- `createdAt/updatedAt: string(ISO)`
- `status: "active" | "retired"`
- `card.md`（角色卡：来自 character-card skill 输出）

**CanonEntry（正典条目）**（先做最小闭环：有存储、有检索、有冲突提示）

- `id: number`（可选：后续需要再加自增）
- `worldId: number`
- `type: "event" | "rule" | "character" | "location" | "other"`
- `status: "draft" | "published"`
- `title: string`
- `content: string`（或文件）
- `createdBy: string`
- `createdAt: string(ISO)`

**Membership（加入世界的人）**

- `worldMembers: Set<userId>`：用于访客数（join 数）

**ActiveCharacterState（每个用户在世界里的当前角色；用户扮演）**

- `activeCharacterIdByUser`：`(worldId,userId) -> characterId`

### 4.2 关键关系（这才是“系统”）

```
guildId
  └─ worldId (N 个)
       ├─ channelId[] (category + channels)
       ├─ members[userId]
       ├─ characters[characterId]
       └─ events[]
```

把这张关系表维护正确，其他功能都是“读/写这些集合”。

---

## 5. 持久化方案（Redis + 文件；别做大一统数据库幻想）

### 5.1 为什么不用 PG

你已经说了：PG 不再需要，而且上下文只用 opencode session。那就别搞两套存储。

**最实用的组合：**

- **Redis（持久化 AOF/RDB）**：存索引、计数、映射、状态（小而频繁）。
- **文件系统（/data）**：存世界卡/规则/角色卡/地图等“大文本与资产”。

### 5.2 Redis Key 设计（建议）

自增：

- `world:next_id` → `INCR`
- `character:next_id` → `INCR`

索引（否则 `/world list` 只能扫库）：

- `world:ids` → `SADD worldId`（存在性集合）
- `world:created_at` → `ZADD timestampMs worldId`（按创建时间排序）

世界元信息：

- `world:{worldId}:meta` → `HSET`
  - fields：`homeGuildId creatorId name status createdAt updatedAt categoryId infoChannelId roleplayChannelId proposalsChannelId voiceChannelId roleId`

频道路由：

- `world:{worldId}:channels` → `SET(channelId)`（可选；也可放 meta 里）
- `channel:{channelId}:world` → `SET worldId`（严格来说 `STRING` 就够）

成员与计数：

- `world:{worldId}:members` → `SADD userId`（`SCARD` = 访客数）
- `world:{worldId}:characters` → `SADD characterId`（`SCARD` = 角色数）
- `user:{userId}:worlds` → `SADD worldId`（方便查询我加入了哪些世界）

角色元信息：

- `character:{characterId}:meta` → `HSET`（`worldId creatorId name status createdAt updatedAt`)
- `user:{userId}:characters` → `SADD characterId`（用于 `/character view [@用户]`）

当前角色状态（用户扮演）：

- `world:{worldId}:active_character:{userId}` → `SET characterId`

统计时间序列（最小可用）：

- `world:{worldId}:stats:daily` → `HINCRBY {YYYY-MM-DD} join|character|rpMessage ...`
  - 或者直接只靠 `events.jsonl` 统计，先别过早优化。

### 5.3 文件目录结构（建议）

以 `DATA_DIR` 为根（默认推导为 `/data`），新增：

```
/data/worlds/{worldId}/
  world-card.md
  rules.md
  map/
  characters/{characterId}.md
  canon/
  events.jsonl
```

写入规则：

- 世界卡/规则/角色卡：**写临时文件 + rename**（原子替换）
- events：`appendFile`（追加即可）

---

## 6. Discord 子空间结构（参考你给的截图）

创建世界后自动创建：

- Category：`[WorldName]`（建议带 ID：`[W12] WorldName`，避免重名）
- `#world-info`：世界卡、规则、地图、统计（所有人可读）
- `#world-roleplay`：主要对话区（准入控制）
- `#world-proposals`：正典提案/剧情变化/地图更新申请
- `World Voice`：语音（可选）

### 6.1 “看得到但不能进”的两种实现（别装死，这里必须选）

这里先把“能看到但不能进入”说清楚：  
**能看到** = 能获取/阅读世界信息（世界卡/规则/地图/统计/编年史），不要求成为成员。  
**不能进入** = 不能在世界里产生可写行为（发言/提案/创建角色/设置当前角色），直到 `/world join` 成为成员。

落到 Discord 体验上：

- `#world-info`：所有人可读（世界展示面）
- `#world-roleplay` / `#world-proposals` / Voice：仅成员可发言/提交/连接（世界入口）

**方案 A：只做 bot 层准入（最简单）**

- 所有人都能发言，但 bot 只响应已 join 的用户。
- 优点：实现简单，几乎不碰 Discord 权限。
- 缺点：频道会被路人聊天污染，沉浸感差。

**方案 B：世界 Role 实现准入（推荐）**

- 每个世界创建一个 Discord Role（例如 `World-12`）。
- `#world-roleplay`：@everyone 仅可 view，不可 send；`World-12` 可 send。
- `/world join` 给用户加 role；作者自动加 role。
- 优点：体验对；“不能进入”变成真实权限。
- 缺点：每个世界一个 role；需要处理删除/重命名/上限（但比 per-user overwrite 强太多）。

我倾向 B，因为 A 最后一定会被骂。

> 你已确认选择：**方案 B**。后续设计与实现以此为前提。

**未加入时 bot 的响应策略（你已确认：会响应）**

- 只读命令（如 `/world info|rules|stats`）对所有人可用。
- 写入类命令（如 `/character create`、`/submit`）未 join 则明确拒绝并引导去该世界的 `#world-join` 执行 `/world join`。
- `/world join` 若在非 `homeGuild` 执行：应提示“该世界入口在 `homeGuild`，你需要加入该服务器后再 join”，不要在错误的 guild 里半 join 半失败。

---

## 7. 世界频道与 opencode session 隔离（关键：不要把世界混在一起）

### 7.1 目标

当用户在 `#world-roleplay` 里聊天：

- 使用新的 session（与主频道、与其他世界完全隔离）
- 不注入跨世界/跨群历史（已由 NoopHistoryStore 达成）
- session 内可通过 skill 只读获取该世界信息（世界卡/规则/地图）

### 7.2 channelId → worldId → virtual groupId

你已决定“世界全局共享”，所以 `groupId` 应该只跟 `worldId` 绑定，而不是跟某个 guild 绑定。建议定义：

```
virtualGroupId = "world_{worldId}"
```

满足现有 safe path segment 规则（字母数字 + `._-`）。

路由逻辑（设计）：

1. 收到 Discord 消息，取 `channelId`
2. 查 Redis `channel:{channelId}:world`
3. 命中则 `groupId = virtualGroupId`，否则 `groupId = guildId`

这会让会话目录自然隔离：`.../sessions/{botId}/world_{worldId}/...`

### 7.3 always-on（世界 roleplay 频道必须默认触发）

现有 trigger 机制会忽略无 mention/无 keyword 的消息。  
世界 roleplay 频道要做成“说话就触发”，必须：

- 在 dispatch 阶段识别该 channel 是 world roleplay channel，并强制 enqueue；或
- 给该 world 的 groupConfig 写入关键词并要求用户使用唤醒词（体验很差，不推荐）。

---

## 8. 指令清单与“是否需要 opencode 介入”

你提的“每次创作/变更都要想 3 件事”我直接固化成表。

### 8.1 权限与可见性约定（先写死，别靠口头）

**`/world create` 权限（按 guild 配置）**

把“谁能创建世界”当成 guild 的运营策略，而不是世界的属性。建议落在群配置（`/data/groups/{guildId}/config.yaml`）里：

```yaml
world:
  createPolicy: admin # admin | whitelist | open
  createWhitelist: [] # 当 createPolicy=whitelist 生效
```

判定规则（从严到松）：

- `admin`：仅 Discord 管理员 + `adminUsers`（现有逻辑）
- `whitelist`：admin + `createWhitelist`
- `open`：任意成员

**角色卡可见性（按角色字段）**

- `world`：仅已 `/world join` 的成员可见
- `public`：所有人可见（含未 join）
- `private`：仅创建者可见

默认值已确定为 `world`。

| 功能       | 命令                         | 解决             | 是否需要 opencode                        | 权限/差异                                        | 持久化写入                                           |
| ---------- | ---------------------------- | ---------------- | ---------------------------------------- | ------------------------------------------------ | ---------------------------------------------------- |
| 世界创建   | `/world create`              | 想创造自己的世界 | **是**（把上传文档规范成世界卡/规则）    | guild 配置：仅管理员/白名单/全开（默认 `admin`） | Redis(meta+映射)+文件(world-card/rules)+Discord 资源 |
| 世界列表   | `/world list`                | 找世界           | 否                                       | 所有人                                           | 否（读）                                             |
| 世界详情   | `/world info <id>`           | 查看世界卡       | 否（直接读文件）                         | 所有人                                           | 否（读）                                             |
| 世界规则   | `/world rules <id>`          | 世界底层逻辑     | 否（直接读文件）                         | 所有人                                           | 否（读）                                             |
| 加入世界   | `/world join`                | 进入游玩         | 否                                       | 所有人（仅在 `#world-join` 执行）                | Redis(set)+events(+Discord role)                     |
| 世界统计   | `/world stats <id>`          | 影响力可视化     | 否                                       | 所有人                                           | 读 Redis / events                                    |
| 地图生成   | `/map generate <描述>`       | 可视化世界结构   | **是/外部 banana**                       | 世界创建者/管理员                                | 文件(map)+events                                     |
| 地图更新   | `/map update <id> <变化>`    | 动态反映变化     | **是/外部 banana**                       | 世界创建者/管理员                                | 文件(map)+events                                     |
| 冲突检测   | `/check <设定>`              | 设定冲突怎么办   | **是**（检索+总结冲突）                  | 世界创建者/管理员（或开放）                      | 否（读）                                             |
| 正典提案   | `/submit <类型> <内容>`      | 想被认可记录     | **是**（格式化、补全字段）               | 任何人提交，创作者确认                           | Redis/文件(draft)+events                             |
| 编年史记录 | `/chronicle add <事件>`      | 永久记录         | 可选（润色）                             | 仅创作者/管理员                                  | 文件(canon)+events                                   |
| 创建角色   | `/character create`          | 创建人设         | **是**（按模板生成角色卡；引用世界规则） | 需已 join                                        | Redis(meta+索引)+文件(card)+events                   |
| 查看角色   | `/character view ...`        | 看角色卡         | 否                                       | 角色字段：`world`/`public`/`private`             | 否（读）                                             |
| 更新角色   | `/character update ...`      | 改人设           | 可选（重写卡片）                         | 仅角色创建者                                     | 文件+events                                          |
| 角色迁移   | `/character migrate <world>` | 跨世界           | 否/可选（适配规则）                      | 仅角色创建者且需 join 目标世界                   | Redis 索引变更+文件移动+events                       |
| 角色经历   | `/character history`         | 成就记录         | 可选（从 events/会话总结）               | 仅本人                                           | 文件/Redis（后续）                                   |
| NPC 代理   | `/npc create ...`            | 让创作活起来     | 是（长驻代理）                           | 仅创作者/管理员                                  | 复杂：先别做                                         |

**关键规则：** 权限判断必须在 bot 代码里做，别让 opencode“自己决定能不能写”。那是把系统安全交给随机输出。

---

## 9. Skill 规划（这是 bot 的 skills，不是 Codex skills）

你提供的模板文件：

- `/Users/zyp/Downloads/world-design-card-skill.md`
- `/Users/zyp/Downloads/character-card-skill.md`

本仓库的 opencode skills 结构是：`configs/skills/<skillName>/SKILL.md`（会同步进 session workspace）。

计划新增（命名建议）：

- `configs/skills/world-design-card/SKILL.md`：世界卡结构化生成
- `configs/skills/character-card/SKILL.md`：角色卡结构化生成
- `configs/skills/world-readonly/SKILL.md`：在 roleplay 前**必读** `workspace/world/` 下的世界卡与规则，禁止胡编世界设定
- `configs/skills/canon-conflict-check/SKILL.md`：冲突检测的工作流（先检索正典，再输出冲突点）

注意：skill 只是一套提示词/工作流，**持久化写入仍由 bot 代码执行**，否则你就是在给模型发“随便写磁盘”的通行证。

---

## 10. 待办清单（按依赖顺序）

> 这部分就是“后续需要处理的事情”，你要的就是这个。

1. 定义 World/Character 的 zod schema（meta）与 Redis key 约定（写死，别模糊）。
2. 新增 WorldStore（Redis）+ WorldFileStore（/data/worlds）抽象，写入采用原子 rename。
3. Discord slash commands：
   - `/world create|list|info|rules|join|stats`
   - `/character create|view|update|migrate|history`
   - `/map generate|update`
4. Discord 子空间创建：category + channels + world role；落库映射 `channelId -> worldId`。
5. Dispatch 路由改造：识别 world channel 并重写 `groupId = world_{worldId}`。
6. Trigger 改造：world roleplay channel **always-on**（不依赖 mention/keyword）。
7. `/world join`：写 members set + 赋 role。
8. `/world stats`：直接读 `SCARD(members)` 和 `SCARD(characters)`；附带最近 N 条 events（时间变化）。
9. 角色创建最小闭环：生成角色卡文件 + 绑定世界 + 角色数统计。
10. 正典系统 MVP：`/submit` 产出 draft；创作者 `/chronicle add` 发布；`/check` 做冲突提示。

---

## 11. 已确认默认值

- 世界创建权限默认：`world.createPolicy = admin`
- 角色卡默认可见性：`character.visibility = world`
