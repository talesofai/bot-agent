---
name: skill-authoring
description: 生成或优化 Claude Code Skills/ CC Skills。用于设计 Skill 结构、编写 SKILL.md、补充脚本/参考资料，并确保符合 CC 的路径、命名、前置 YAML 规范与最佳实践。
---

# CC Skill 生成与优化

## 使用范围

- 生成新的 CC Skill（结构 + SKILL.md + 可选脚本/参考资料）。
- 优化已有 CC Skill（触发描述、步骤清晰度、资源组织）。

## 基本流程

1. 确认 Skill 的使用场景与触发语句（用户会怎么提问）。
2. 按 CC 规范创建目录结构与 `SKILL.md`。
3. 将可复用的脚本放入 `scripts/`，将长文档放入 `references/`。
4. 在 `SKILL.md` 中链接 `references/`，保持正文精简。
5. 使用 `scripts/validate_skill.sh` 做快速校验。

## CC 规范速览

- 目录：`.claude/skills/<skill-name>/SKILL.md`
- 命名：小写字母/数字/短横线
- `SKILL.md`：必须包含 YAML frontmatter（仅 `name` 与 `description`）
- `description`：写清楚“做什么”和“何时使用”（包含触发词）

## 模板与脚本

- 示例模板：`assets/skill-template/SKILL.md`
- 校验脚本：`scripts/validate_skill.sh`

## 参考文档

详见 `references/cc-skills.md`。
