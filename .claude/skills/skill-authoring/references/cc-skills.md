# Claude Code (CC) Skills 规范速查

本文档用于在生成/优化 Skill 时快速对齐 CC 规范与最佳实践。

## 官方文档

- Agent Skills 页面：`https://code.claude.com/docs/zh-CN/skills`
- Claude Code 概览：`https://code.claude.com/docs/zh-CN/overview`
- Best Practices：`https://docs.claude.com/zh-CN/docs/agents-and-tools/agent-skills/best-practices`
- Quickstart：`https://docs.claude.com/zh-CN/docs/agents-and-tools/agent-skills/quickstart`

## 目录与路径

Skills 必须位于以下路径之一（区分大小写）：

- 个人：`~/.claude/skills/<skill-name>/SKILL.md`
- 项目：`.claude/skills/<skill-name>/SKILL.md`

## 目录结构建议

```
.claude/skills/<skill-name>/
├── SKILL.md
├── scripts/        # 可执行脚本（可选）
├── references/     # 参考资料（可选）
└── assets/         # 输出资源/模板（可选）
```

## SKILL.md 要求

- 必须包含 YAML frontmatter。
- frontmatter 仅包含 `name` 与 `description`。
- `description` 需要同时覆盖：
  - Skill 能做什么
  - 用户会如何提问（触发词/场景）

示例：

```yaml
---
name: pdf-tools
description: Extract text and tables from PDF files, fill forms, merge documents. Use when the user mentions PDFs, forms, or document extraction.
---
```

## 触发与冲突

- 描述过于相似会导致误触发。
- 建议用更具体的触发词区分相近技能。

## 资源组织建议

- 通用流程放在 `SKILL.md`。
- 详细规范/示例放在 `references/`，并在 `SKILL.md` 里指引读取。
- 重复性或易错步骤用 `scripts/` 固化。

## 校验与打包

### 本地校验

- 使用 `scripts/validate_skill.sh <skill-dir>` 做结构与 frontmatter 快检。
- 建议用 `claude --debug` 查看加载错误（如路径或 YAML 问题）。

### 打包/分享

CC Skill 通常无需单独打包，放在以下路径即可加载：

- 项目内：`.claude/skills/<skill-name>/SKILL.md`
- 个人：`~/.claude/skills/<skill-name>/SKILL.md`

如需分享，可将整个 Skill 目录打包（zip）或以仓库形式共享。

## 常见问题

- **不加载**：路径不正确或 frontmatter YAML 格式错误。
- **脚本不可用**：缺少执行权限或依赖未安装。
