---
name: character-portrait
description: 角色立绘生成（优先 make image，可带参考图）。
---

# character-portrait

## 目标

根据角色卡生成角色立绘；若提供参考图，则在参考图基础上改图并保持角色一致性。

## 输入来源优先级

1. `world/active-character.md`
2. `character/character-card.md`
3. 当前用户消息中的补充描述

若都不足：先追问外貌、服装、标志特征、画风（4 点）。

## 工具策略

优先链路：

- `mcp_talesofai_make_image_v1`（纯立绘生成）

参考图链路：

- `mcp_talesofai_edit_image_beta`

回退：

- `mcp_talesofai_draw`

## 生成约束

- 只生成 1 张
- 优先竖构图（3:4 或最接近比例）
- 输出需符合角色卡（年龄、体型、服装、气质）

## 输出格式

- 仅输出：`![](URL)`
- 禁止附加无关解释与虚假链接
