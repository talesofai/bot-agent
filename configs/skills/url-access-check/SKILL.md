---
name: url-access-check
description: 在回复中提供任何 URL（尤其是图片链接）前，用脚本验证该 URL 在当前运行环境可解析且可访问，避免 NXDOMAIN/403/404/非图片导致“给了链接但用不了”。
---

# URL 可达性验证

## 什么时候必须用

- 你要给用户一个可点击的链接（文档/下载/网页/图片等）。
- 你要返回图片（Markdown 图片或裸图片 URL）。

## 规则（别自欺欺人）

- **没跑过验证脚本，就别说“已验证/可用/能打开”。**
- 验证失败：明确说明“在当前环境无法访问”，并要求用户提供可访问来源或让用户直接上传图片。
- 图片链接必须满足：HTTP 2xx/3xx（可跟随重定向）且 `Content-Type` 为 `image/*`。

## 用法

- 普通 URL：
  - `bash .claude/skills/url-access-check/scripts/check_url.sh <url>`
- 图片 URL：
  - `bash .claude/skills/url-access-check/scripts/check_url.sh --image <url>`

脚本输出以 `OK` 开头才算通过。
