---
name: nano
description: /nano 文生图与角色立绘（TalesOfAI MCP / banana）。
---

# /nano 绘图技能（banana）

## 触发条件

- 用户消息以 `/nano` 开头（大小写不敏感）。

## 功能

1. 创建插画

- `/nano <描述>`
- 任意描述 → 生成 1 张插画

2. 角色画像生成（立绘）

- `/nano portrait [额外描述]`
- 基于当前角色设定自动生成角色立绘（优先全身、竖构图）。

## 数据来源（portrait）

按优先级读取：

1. `world/active-character.md`（世界子空间会话里由系统写入；玩家需先 `/character act`）
2. `character/character-card.md`（角色编辑会话里）

若两者都不存在或内容为空：直接向用户要“外貌 + 服装 + 标志特征 + 气质/风格”四项信息（用 3-6 条要点即可），不要瞎编。

## 生成方式（必须）

必须调用 TalesOfAI MCP 的图片工具完成（banana）：

优先：

- `mcp_talesofai_edit_image_beta`（不传参考图，仅用文本提示词做文生图）

回退：

- `mcp_talesofai_make_image_v1`

要求：

- 生成英文提示词（必要时先把中文转为英文再生成）
- portrait 默认使用竖构图（优先 3:4；如工具不支持则选最接近的纵向比例）
- 只生成 1 张图

## 输出格式（必须）

- 最终只输出图片，不要长篇解释。
- 用 Markdown 图片语法输出：`![](URL)`
- 不要输出附件（不要把图片内容写进文件）。
- 不要伪造 URL；只输出工具返回的产物 URL。

## 提示词建议（供你生成英文 prompt 用）

- 画面质量：high quality, detailed, sharp focus
- 构图：full body, standing pose, centered composition, clean background
- 风格：anime illustration / semi-realistic（按用户描述）
- 光照：soft lighting / dramatic lighting（按用户描述）
- 避免：nsfw, gore, explicit violence
