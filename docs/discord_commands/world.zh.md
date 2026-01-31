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
