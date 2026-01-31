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
