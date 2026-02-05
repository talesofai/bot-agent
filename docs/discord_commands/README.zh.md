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
- `/onboard role:admin|both|adventurer|world creater`：新手引导（创建/打开你的私密引导话题）
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
