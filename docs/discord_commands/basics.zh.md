# 基础指令（Slash Commands）

本页覆盖最常用的通用指令：`/help`、`/ping`、`/onboard`、`/language`。

## `/help`

查看可用指令与简要说明。

## `/ping`

健康检查，用于确认 bot 在线。

## `/onboard role:player|creater`

新手引导。会在服务器内创建/打开你的私密引导话题（Thread），后续你在该话题内可以直接对 bot 说话（无需每句 @bot）。

如果服务器启用了 Discord Server Onboarding（身份组）并配置了身份组角色映射，bot 会在你选择身份组并被分配角色后自动开启对应引导；此时你不需要手动执行 `/onboard`。`/onboard` 仍可用于找回入口链接或切换身份。

- `role=player`：冒险者视角的引导流程（创建角色、加入世界开始玩）
- `role=creater`：世界创建者视角的引导流程（创建/发布世界）

示例：

```text
/onboard role:player
/onboard role:creater
```

## `/language lang:zh|en`

设置你的默认回复语言，并影响世界/角色相关文档的写入语言。

示例：

```text
/language lang:zh
/language lang:en
```
