<!-- Bundled from docs/discord_commands/*.md -->

<!-- BEGIN FILE: docs/discord_commands/README.zh.md -->

# Discord 指令简介（总览）

本目录用于集中说明 **Discord 平台**的指令用法（Slash Commands + 消息快捷指令），并会被 World Wiki 的“指令”栏目引用。

## 快速导航

- 基础指令：[`basics.md`](./basics.md)
- 管理与会话：[`admin.md`](./admin.md)
- 聊天快捷指令：[`chat.md`](./chat.md)
- 世界系统：[`world.md`](./world.md)
- 角色系统：[`character.md`](./character.md)

## 总览

### Slash Commands（Discord 斜杠指令）

- `/help`：查看可用指令与快速提示
- `/ping`：健康检查
- `/onboard role:player|creator`：新手引导（创建/打开你的私密引导话题）
- `/language lang:zh|en`：设置 bot 回复语言（同时影响世界/角色文档写入语言）
- `/reset [key] [user]`：重置对话（创建新 session；管理员可指定 user）
- `/resetall [key]`：重置全群对话（仅管理员）
- `/model name:<modelId|default>`：切换群模型（仅管理员；`default` 清除覆盖）
- `/world …`：世界系统（创建/发布/正典/提案/加入等）
- `/character …`：角色系统（创建/发布/使用/导入导出等）

### 消息快捷指令（直接发消息）

这些是“消息内容级”的快捷指令：你直接在频道发消息即可（不要求必须用 Slash Command）。

- `#<key> <内容>`：指定会话槽位（例如 `#2 继续刚才的话题`）
- `.rd NdM`：掷骰（例如 `.rd 2d100`；不走 AI）
- `/nano <描述>`：文生图（走内置 skill）
- `/nano portrait [额外描述]`：角色立绘（走内置 skill）
- `/polish <草稿>`：润色改写（走内置 skill）
- `/quest`：生成 3–5 个可执行小任务（走内置 skill）
- `/reset` / `/reset all`：重置会话（等价于 `/reset`/`/resetall` 的消息版本）
- `/model <name>` / `/model default`：切换模型（等价于 `/model` 的消息版本）

> 详细用法见各分文档。此处只做索引，不展开规则细节。

<!-- END FILE: docs/discord_commands/README.zh.md -->

---

<!-- BEGIN FILE: docs/discord_commands/README.en.md -->

# Discord Commands (Overview)

This folder documents **Discord commands** (Slash Commands + message shortcuts). It is also linked from the World Wiki “Commands” section.

## Quick Links

- Basics: [`basics.md`](./basics.md)
- Admin & Sessions: [`admin.md`](./admin.md)
- Chat Shortcuts: [`chat.md`](./chat.md)
- World System: [`world.md`](./world.md)
- Character System: [`character.md`](./character.md)

## Overview

### Slash Commands

- `/help`: Show available commands and tips
- `/ping`: Health check
- `/onboard role:player|creator`: Onboarding (creates/opens your private onboarding thread)
- `/language lang:zh|en`: Set reply language (also affects world/character doc writing language)
- `/reset [key] [user]`: Reset session (admins can target a user)
- `/resetall [key]`: Reset all sessions in the guild/channel scope (admin only)
- `/model name:<modelId|default>`: Switch model override (admin only; `default` clears override)
- `/world …`: World system (create/publish/canon/proposals/join, etc.)
- `/character …`: Character system (create/publish/use/import/export, etc.)

### Message Shortcuts (send as plain messages)

These are **content-level** shortcuts: you can send them as normal messages (no need to use Slash Commands).

- `#<key> <text>`: Select a session slot (e.g. `#2 continue`)
- `.rd NdM`: Dice roll (e.g. `.rd 2d100`; does NOT call AI)
- `/nano <prompt>`: Text-to-image (built-in skill)
- `/nano portrait [extra]`: Portrait preset (built-in skill)
- `/polish <draft>`: Rewrite/polish text (built-in skill)
- `/quest`: Generate 3–5 actionable next steps (built-in skill)
- `/reset` / `/reset all`: Reset sessions (message version of reset commands)
- `/model <name>` / `/model default`: Switch model (message version of `/model`)

See the sub-pages for details.

<!-- END FILE: docs/discord_commands/README.en.md -->

---

<!-- BEGIN FILE: docs/discord_commands/basics.zh.md -->

# 基础指令（Slash Commands）

本页覆盖最常用的通用指令：`/help`、`/ping`、`/onboard`、`/language`。

## `/help`

查看可用指令与简要说明。

## `/ping`

健康检查，用于确认 bot 在线。

## `/onboard role:player|creator`

新手引导。会在 home guild 内创建/打开你的私密引导话题（Thread），后续你在该话题内可以直接对 bot 说话（无需每句 @bot）。

如果服务器启用了 Discord Server Onboarding（身份组）并配置了身份组角色映射，bot 会在你选择身份组并被分配角色后自动开启对应引导；此时你不需要手动执行 `/onboard`。`/onboard` 仍可用于找回入口链接或切换身份。

- `role=player`：玩家视角的引导流程
- `role=creator`：创作者视角的引导流程

示例：

```text
/onboard role:player
```

## `/language lang:zh|en`

设置你的默认回复语言，并影响世界/角色相关文档的写入语言。

示例：

```text
/language lang:zh
/language lang:en
```

<!-- END FILE: docs/discord_commands/basics.zh.md -->

---

<!-- BEGIN FILE: docs/discord_commands/basics.en.md -->

# Basics (Slash Commands)

This page covers the most common commands: `/help`, `/ping`, `/onboard`, `/language`.

## `/help`

Shows available commands and short tips.

## `/ping`

Health check. Useful to confirm the bot is online.

## `/onboard role:player|creator`

Onboarding. It creates/opens your private onboarding thread in the home guild. Inside that thread, you can talk to the bot without mentioning it every time.

If your server enables Discord Server Onboarding (identity roles) and configures role mapping, the bot will auto-start the onboarding guide right after you pick an identity role and roles are assigned. `/onboard` still works to recover the entry link or switch roles.

- `role=player`: player onboarding flow
- `role=creator`: creator onboarding flow

Example:

```text
/onboard role:player
```

## `/language lang:zh|en`

Sets your preferred reply language and affects the writing language of world/character docs.

Examples:

```text
/language lang:zh
/language lang:en
```

<!-- END FILE: docs/discord_commands/basics.en.md -->

---

<!-- BEGIN FILE: docs/discord_commands/chat.zh.md -->

# 聊天快捷指令（消息指令）

这些指令是“直接发消息”的快捷入口，适合日常聊天与轻量功能，不要求必须用 Slash Commands。

## `#<key> <内容>`（会话槽位）

用于切换会话槽位（多槽位并行上下文）。

示例：

```text
#0 继续这个话题
#2 换个支线
```

> `key` 的上限由群配置 `maxSessions` 决定；超过会被丢弃。

## `.rd NdM`（掷骰）

格式：`.rd NdM`，例如 `.rd 2d100`。

- `1 <= N <= 10`
- `1 <= M <= 100`

示例：

```text
.rd 1d20
.rd 2d100
```

## `/nano <描述>` / `/nano portrait [额外描述]`

文生图快捷指令。

示例：

```text
/nano 一只戴墨镜的柴犬，赛博朋克风格
/nano portrait 银发女骑士，冷色调
```

## `/polish <草稿>`

润色改写：只对后面的草稿做改写，不新增事实设定（适合把一段话写顺）。

示例：

```text
/polish 我今天很累，但还得继续。
```

## `/quest`

生成 3–5 个可执行的小任务（通常会给出具体步骤/命令）。

示例：

```text
/quest
```

<!-- END FILE: docs/discord_commands/chat.zh.md -->

---

<!-- BEGIN FILE: docs/discord_commands/chat.en.md -->

# Chat Shortcuts (Message Commands)

These are message-level shortcuts you can send as plain text messages (no need to use Slash Commands).

## `#<key> <text>` (session slot)

Selects a session slot (parallel contexts).

Examples:

```text
#0 continue this topic
#2 start a side thread
```

> The max slot is controlled by the group config `maxSessions`. Out-of-range keys are dropped.

## `.rd NdM` (dice roll)

Format: `.rd NdM`, e.g. `.rd 2d100`.

- `1 <= N <= 10`
- `1 <= M <= 100`

Examples:

```text
.rd 1d20
.rd 2d100
```

## `/nano <prompt>` / `/nano portrait [extra]`

Text-to-image shortcuts.

Examples:

```text
/nano a shiba inu wearing sunglasses, cyberpunk style
/nano portrait silver-haired knight, cool tones
```

## `/polish <draft>`

Polishes/re-writes the following draft without adding new facts/canon.

Example:

```text
/polish I'm tired today, but I still need to keep going.
```

## `/quest`

Generates 3–5 small actionable tasks (often with concrete steps/commands).

Example:

```text
/quest
```

<!-- END FILE: docs/discord_commands/chat.en.md -->

---

<!-- BEGIN FILE: docs/discord_commands/character.zh.md -->

# 角色系统（`/character`）

`/character` 用于创建、编辑、发布与使用角色卡。

## `/character help`

查看角色系统指令用法。

## `/character create [name] [visibility] [description]`

创建角色卡草稿，并进入编辑话题（Thread，多轮补全）。

- `visibility`：`public|private`（默认 `private`）

## `/character open character_id:<id>`（仅创作者）

打开指定角色的编辑话题。

## `/character view character_id:<id>`

查看角色卡。

## `/character use character_id:<id>`

设置你的默认角色（全局）。

## `/character act character_id:<id>`

设置你在“当前世界”的当前角色（world 内的状态）。

## `/character publish [character_id]` / `/character unpublish [character_id]`

将角色设为公开/不公开：

- `public` 才能被 `list/search` 检索到
- `character_id` 可省略（在编辑话题中会取当前角色）

## `/character list [limit]`

列出我的角色。

## `/character search query:<关键词> [limit]`

搜索公开角色（`public`）。

## `/character adopt character_id:<id> mode:<copy|fork>`

使用公开角色：复制或 fork 为你的角色（默认不公开）。

## `/character export [character_id]`（仅创作者）

导出角色卡。

## `/character import file:<附件> [character_id]`（仅创作者）

上传并覆盖角色卡（允许 `.md/.markdown/.txt`）。

<!-- END FILE: docs/discord_commands/character.zh.md -->

---

<!-- BEGIN FILE: docs/discord_commands/character.en.md -->

# Character System (`/character`)

`/character` lets you create/edit/publish/use character cards.

## `/character help`

Shows character command usage.

## `/character create [name] [visibility] [description]`

Creates a character draft and opens an editing thread (multi-turn completion).

- `visibility`: `public|private` (default `private`)

## `/character open character_id:<id>` (creator only)

Opens the editing thread for a character.

## `/character view character_id:<id>`

Views a character card.

## `/character use character_id:<id>`

Sets your default character (global).

## `/character act character_id:<id>`

Sets your active character in the current world (world-scoped state).

## `/character publish [character_id]` / `/character unpublish [character_id]`

Publishes/unpublishes a character:

- only `public` characters are discoverable via `list/search`
- `character_id` can be omitted in the editing thread

## `/character list [limit]`

Lists your characters.

## `/character search query:<keyword> [limit]`

Searches public characters.

## `/character adopt character_id:<id> mode:<copy|fork>`

Adopts a public character by copying or forking it into your own list (default private).

## `/character export [character_id]` (creator only)

Exports a character card.

## `/character import file:<attachment> [character_id]` (creator only)

Imports (overwrites) a character card (`.md/.markdown/.txt` only).

<!-- END FILE: docs/discord_commands/character.en.md -->

---

<!-- BEGIN FILE: docs/discord_commands/world.zh.md -->

# 世界系统（`/world`）

`/world` 是世界系统的入口：创建世界、发布子空间、提交/确认正典与提案、加入世界等。

## `/world help`

查看世界系统指令用法。

## `/world create`（创建草稿世界）

创建世界草稿，并进入你的私密编辑话题（Thread）。后续通过多轮对话补全世界卡与规则，最后用 `/world publish` 发布。

## `/world open world_id:<id>`（仅创作者）

打开指定世界的编辑话题。

## `/world publish`（仅创作者，需在编辑话题中执行）

发布当前草稿世界：创建世界子空间（频道/角色等），并对外可见。

## `/world list [limit]`

列出世界（全局）。

## `/world search query:<关键词> [limit]`

搜索世界（按名称/世界卡/规则）。

## `/world info [world_id]`

查看世界卡（在世界子空间频道内可省略 `world_id`）。

## `/world rules [world_id]`

查看世界规则（在世界子空间频道内可省略 `world_id`）。

## `/world canon query:<关键词> [world_id]`

搜索本世界正典（世界卡/规则）。

## `/world submit kind:<canon|chronicle|task|news> title:<标题> content:<内容> [world_id]`

提交提案/任务/正典补充（会写入 `world-proposals`，等待创作者确认）。

## `/world approve submission_id:<id> [world_id]`（仅创作者）

确认提交并写入正典/任务/编年史。

## `/world check query:<关键词> [world_id]`

检查/搜索世界正典与提案是否包含某关键词。

## `/world join [world_id] [character_id]`

加入世界（获得发言权限）。可选指定 `character_id`，否则使用你的当前角色。

## `/world stats [world_id]` / `/world status [world_id]`

查看世界统计/状态（`status` 与 `stats` 等价）。

## `/world export [world_id]`（仅创作者）

导出世界文档（world-card / rules / canon）。

## `/world import kind:<world_card|rules|canon> file:<附件> [world_id]`（仅创作者）

上传并覆盖世界文档：

- `kind=world_card`：覆盖 `world-card.md`
- `kind=rules`：覆盖 `rules.md`
- `kind=canon`：覆盖 `canon/<filename>`（文件名来自附件名；允许 `.md/.markdown/.txt`）

## `/world remove world_id:<id>`（管理员）

移除世界（危险操作）。

<!-- END FILE: docs/discord_commands/world.zh.md -->

---

<!-- BEGIN FILE: docs/discord_commands/world.en.md -->

# World System (`/world`)

`/world` is the entry point of the world system: create/publish worlds, manage proposals/canon, and join worlds.

## `/world help`

Shows world command usage.

## `/world create` (create draft world)

Creates a draft world and opens your private editing thread. Complete the world card/rules through multi-turn chat, then publish with `/world publish`.

## `/world open world_id:<id>` (creator only)

Opens the editing thread for a specific world.

## `/world publish` (creator only; run inside the editing thread)

Publishes the current draft world and creates the world space (channels/role, etc.).

## `/world list [limit]`

Lists worlds (global).

## `/world search query:<keyword> [limit]`

Searches worlds by name/world-card/rules.

## `/world info [world_id]`

Shows the world card (`world_id` can be omitted inside that world’s channels).

## `/world rules [world_id]`

Shows the world rules (`world_id` can be omitted inside that world’s channels).

## `/world canon query:<keyword> [world_id]`

Searches canon (world-card/rules) for a keyword.

## `/world submit kind:<canon|chronicle|task|news> title:<title> content:<content> [world_id]`

Submits a proposal/task/canon addition (written to `world-proposals`, pending creator approval).

## `/world approve submission_id:<id> [world_id]` (creator only)

Approves a submission and writes it into canon/tasks/chronicle.

## `/world check query:<keyword> [world_id]`

Checks/searches whether canon/proposals contain a keyword.

## `/world join [world_id] [character_id]`

Joins a world (grants speaking permissions). Optionally specify `character_id`; otherwise uses your current character.

## `/world stats [world_id]` / `/world status [world_id]`

Shows world stats/status (`status` is equivalent to `stats`).

## `/world export [world_id]` (creator only)

Exports world docs (world-card / rules / canon).

## `/world import kind:<world_card|rules|canon> file:<attachment> [world_id]` (creator only)

Imports (overwrites) world docs:

- `kind=world_card`: overwrites `world-card.md`
- `kind=rules`: overwrites `rules.md`
- `kind=canon`: overwrites `canon/<filename>` (filename from the attachment name; `.md/.markdown/.txt` only)

## `/world remove world_id:<id>` (admin)

Removes a world (dangerous).

<!-- END FILE: docs/discord_commands/world.en.md -->

---

<!-- BEGIN FILE: docs/discord_commands/admin.zh.md -->

# 管理与会话指令

本页覆盖会话与管理类指令：`/reset`、`/resetall`、`/model`（以及对应的消息版本）。

## `/reset [key] [user]`

创建新的 session（相当于“换一段新对话上下文”）。

- `key`：会话槽位（默认 0；必须是非负整数）
- `user`：要重置的用户（默认自己；**仅管理员可指定他人**）

示例：

```text
/reset
/reset key:2
/reset key:0 user:@someone
```

消息版本（同义）：

```text
/reset
#2 /reset
```

## `/resetall [key]`（仅管理员）

重置全群对话（按槽位 key）。

示例：

```text
/resetall
/resetall key:1
```

消息版本（同义）：

```text
/reset all
#1 /reset all
```

## `/model name:<modelId|default>`（仅管理员）

切换群模型覆盖：

- `default`：清除群配置里的 model 覆盖，回到默认选择
- `<modelId>`：必须在 `OPENCODE_MODELS` 白名单内（允许包含 `/`）

示例：

```text
/model name:default
/model name:vol/glm-4.7
```

消息版本（同义）：

```text
/model default
/model vol/glm-4.7
```

<!-- END FILE: docs/discord_commands/admin.zh.md -->

---

<!-- BEGIN FILE: docs/discord_commands/admin.en.md -->

# Admin & Session Commands

This page covers session/admin commands: `/reset`, `/resetall`, `/model` (and their message equivalents).

## `/reset [key] [user]`

Creates a new session (i.e., starts a fresh conversation context).

- `key`: session slot (default `0`; must be a non-negative integer)
- `user`: target user (defaults to yourself; **admin only** when targeting others)

Examples:

```text
/reset
/reset key:2
/reset key:0 user:@someone
```

Message equivalents:

```text
/reset
#2 /reset
```

## `/resetall [key]` (admin only)

Resets all sessions in the guild/channel scope for a given slot.

Examples:

```text
/resetall
/resetall key:1
```

Message equivalents:

```text
/reset all
#1 /reset all
```

## `/model name:<modelId|default>` (admin only)

Switches the group model override:

- `default`: clears the override
- `<modelId>`: must be in the `OPENCODE_MODELS` allowlist (slashes `/` are allowed)

Examples:

```text
/model name:default
/model name:vol/glm-4.7
```

Message equivalents:

```text
/model default
/model vol/glm-4.7
```

<!-- END FILE: docs/discord_commands/admin.en.md -->
