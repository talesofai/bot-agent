---
name: bing-image-search
description: 使用 Bing 图片搜索抓取可访问的高分辨率图片直链（默认短边 ≥ 768px），并用 url-access-check 验证后再输出，避免“只有搜索页/空图片框”。
---

# Bing 图片搜索（直链）

当用户要“找图/给图”但 Wikimedia/Unsplash 等站点在当前环境受限（403/429/503）时，使用该技能从 Bing 图片结果中提取 **murl（原图直链）**，并用 `url-access-check` 校验可访问性与分辨率后再输出。

## 用法

- `bash .claude/skills/bing-image-search/scripts/search_images.sh "森蚺" --limit 2`
- `bash .claude/skills/bing-image-search/scripts/search_images.sh "Skadi Arknights" --limit 2 --min-short-side 1024`

## 输出

- 成功：输出若干行 Markdown 图片（`![desc](direct-image-url)`），每条都已通过验证。
- 失败：脚本退出码非 0，并输出以 `FAIL` 开头的原因行。
