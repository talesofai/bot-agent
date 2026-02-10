---
name: command-actions
description: 生成可点击的指令动作卡（按钮），用于引导用户执行下一步。
---

# 可点击指令动作卡

当你需要让用户执行平台指令（而不是继续纯对话）时，使用本技能。

## 输出格式（必须）

在正常回复文本后，追加一个 `command-actions` 代码块，内容为 JSON：

```command-actions
{
  "prompt": "建议先创建角色，再加入世界。",
  "actions": [
    { "action": "character_create", "label": "创建角色卡" },
    { "action": "world_list", "label": "加入现有世界" }
  ]
}
```

说明：

- `prompt` 可选，建议 1 句。
- `actions` 必填，长度 1-5。
- `label` 可选，建议不超过 12 个汉字。

## 允许的 action（白名单）

只允许以下低风险动作：

- `help`（等价 `/help`）
- `character_create`（等价 `/character create`）
- `world_create`（等价 `/world create`）
- `world_list`（等价 `/world list`）
- `world_show`（等价 `/world info`，需 `payload=world_id`）
- `character_show`（等价 `/character view`，需 `payload=character_id`）
- `world_join`（等价 `/world join`，需 `payload=world_id`）

其中：

- `world_show` / `character_show` / `world_join` 必须携带字符串 `payload`（数字 ID）。

## 约束

- 禁止输出白名单以外的 action。
- 禁止伪造执行结果；动作只用于“建议下一步”。
- 当用户已经完成某步时，不要重复推荐同一步。
