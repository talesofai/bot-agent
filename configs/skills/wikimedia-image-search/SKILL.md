---
name: wikimedia-image-search
description: 使用 Wikimedia Commons API 搜索并返回可访问的高分辨率直链图片（默认短边 ≥ 768px），避免输出搜索页链接或 403/缩略图导致“说有图但没图”。
---

# Wikimedia 图片搜索（直链）

当用户要“找图/给图”时，优先用这个技能从 Wikimedia Commons 获取**原图直链**，并在当前环境用 `url-access-check` 验证可访问与分辨率后再输出。

## 用法

- `bash .claude/skills/wikimedia-image-search/scripts/search_images.sh "斯卡蒂" --limit 2`
- `bash .claude/skills/wikimedia-image-search/scripts/search_images.sh "green anaconda" --limit 1 --min-short-side 1024`

## 输出

- 成功：输出若干行 Markdown 图片（`![desc](direct-image-url)`），每条都已通过验证。
- 失败：脚本退出码非 0，并输出以 `FAIL` 开头的原因行。
