---
name: banana-image
description: 通用 banana 生图/改图（TalesOfAI MCP）技能。
---

# banana-image

## 适用场景

- 用户要求生图、改图、重绘、风格化。
- 需要通过 TalesOfAI MCP 完成图片生成或编辑。

## 工具要求（必须）

- 优先：`mcp_talesofai_edit_image_beta`
- 回退：`mcp_talesofai_make_image_v1`
- 兼容：`mcp_talesofai_draw`

禁止：

- 伪造图片 URL
- 用纯文本假装“已生成图片”

## 执行规则

1. 先将用户需求整理成英文 prompt（保留关键风格词）。
2. 如果用户给了参考图，优先使用编辑链路（edit）。
3. 若没有参考图，走文生图。
4. 默认只生成 1 张图，除非用户明确要求多张。

## 输出格式（必须）

- 只输出最终图片：`![](URL)`
- 不输出长篇解释。
