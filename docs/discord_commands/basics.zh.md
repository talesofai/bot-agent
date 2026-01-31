# 基础指令（Slash Commands）

本页覆盖最常用的通用指令：`/help`、`/ping`、`/onboard`、`/language`。

## `/help`

查看可用指令与简要说明。

## `/ping`

健康检查，用于确认 bot 在线。

## `/onboard role:player|creator`

新手引导。会在 home guild 内创建/打开你的私密引导话题（Thread），后续你在该话题内可以直接对 bot 说话（无需每句 @bot）。

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
