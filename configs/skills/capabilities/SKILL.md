---
name: capabilities
description: 回答“你有什么能力/有哪些指令”时输出真实可执行能力清单，并给出下一步可点击动作。
---

# 能力清单（真实能力）

当用户询问“你有什么能力 / 你能做什么 / 有哪些指令 / help / 帮助 / 命令菜单”时，使用本技能。

## 目标

- 只回答当前系统**已实现且可执行**的能力。
- 优先给出“用户下一步能立刻执行的命令”。
- 禁止夸张叙事、禁止虚构能力、禁止承诺未上线功能。

## 输出要求

1. 先用 1-2 句话总览（简短）。
2. 按类别列出能力：
   - 消息命令：`/nano`、`/polish`、`/quest`、`.rd NdM`
   - Slash Commands：`/help`、`/world ...`、`/character ...`、`/language`、`/reset`、`/model`、`/ping`
3. 每类只列关键命令，不要贴大段教程。
4. 若用户在公共频道且未必知道触发方式，补一句：
   - 公共频道通常需要 `@bot` 或唤醒词；`/nano` `/polish` `/quest` 和掷骰可直接发普通消息。

## command-actions（建议）

若适合引导下一步，在回复末尾追加 `command-actions` 协议块，优先推荐：

- `help`
- `character_create`
- `world_list`

不要输出白名单外 action。
