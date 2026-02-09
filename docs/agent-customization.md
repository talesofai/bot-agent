# Agent 自定义指南

本文档介绍如何为每个群自定义 Agent 行为。当前已支持读取群目录下的 `agent.md`、`config.yaml` 与 `skills/{skillName}/SKILL.md`（含脚本目录）。

## 概述

每个群可以有独立的 Agent 配置，包括：

- **人设**：定义 Agent 的性格、背景、行为方式
- **技能**：扩展 Agent 能力的模块化配置
- **触发条件**：何时激活 Agent

## 群目录结构

```
/data/groups/{group_id}/
├── agent.md          # 主要人设配置
├── config.yaml       # 群配置
├── skills/           # 技能目录（按 `{skillName}/SKILL.md` 组织）
│   ├── nano/
│   │   ├── SKILL.md
│   │   └── scripts/
│   └── world-design-card/
│       ├── SKILL.md
│       └── scripts/
└── assets/           # 资源文件
    ├── images/
    └── characters/   # 角色配置（按需自建）
```

## agent.md 配置

这是 Agent 的核心配置文件，使用 Markdown 格式编写。

### 基础模板

```markdown
# 角色名称

你是「小助手」，一个友好的 QQ 群机器人。

## 性格特点

- 热情友好，乐于助人
- 说话简洁明了
- 偶尔会使用表情包

## 行为准则

1. 优先回答群成员的问题
2. 如果不确定答案，诚实地说不知道
3. 避免敏感话题（政治、宗教等）
4. 不要主动提供医疗、法律、财务建议

## 回复风格

- 使用口语化的表达
- 适当使用 emoji 增加亲和力
- 回复长度适中，不要太长

## 特殊指令

- 当用户说"帮助"时，列出可用功能
- 当用户说"画一张"时，调用绘画技能
```

### 高级配置

可以在 agent.md 中定义更复杂的行为：

```markdown
# 晓月

你是「晓月」，一个来自古代仙侠世界的修仙者。

## 背景故事

晓月是青云门的弟子，修炼了三百年，对世间万物充满好奇。
她穿越到了现代，正在学习适应这个新世界。

## 说话方式

- 使用半文言半白话的语气
- 经常用"吾""汝""甚好"等词
- 对现代事物表现出惊奇

## 示例对话

用户: 今天天气怎么样？
晓月: 吾观今日天象，应是晴朗无云。汝可安心外出，无需携伞。

用户: 推荐个好吃的
晓月: 吾虽不需饮食，但听闻人间有「火锅」一物，甚是神奇。汝可一试。

## 能力范围

- 可以进行日常对话
- 可以回答问题（以修仙者视角）
- 可以调用绘画创造"法术效果"

## 禁忌

- 不讨论现代政治
- 不提供真实的修炼方法
- 不假装有超自然能力影响现实
```

## 技能配置

技能采用目录化结构，按 `skills/{skillName}/SKILL.md` 组织，可附带 `scripts/*`。

示例：

```
skills/
├── nano/
│   ├── SKILL.md
│   └── scripts/
├── world-design-card/
│   ├── SKILL.md
│   └── scripts/
└── character-card/
    ├── SKILL.md
    └── scripts/
```

推荐做法：

- 把“行为流程/提示词规则”写进 SKILL，而不是散落在代码文案里
- 在 SKILL 中明确输入、输出格式、失败兜底与安全约束
- 通过群级/机器人级目录覆盖同名 skill，实现定制而不改代码

## config.yaml 配置

群级别的行为配置：

```yaml
# 是否启用 AI 回复
enabled: true

# 触发方式
triggerMode: keyword # mention | keyword（keyword 为“前缀匹配”）
keywords: # keyword 模式的触发词（群级）
  - "小助手"
  - "机器人"
keywordRouting: # 关键词路由开关（群级）
  enableGlobal: true # 是否响应全局关键词
  enableGroup: true # 是否响应群关键词
  enableBot: true # 是否允许机器人关键词
echoRate: null # 复读概率（0-100），空为继承上一级

# 定时热点推送（默认不启用；管理员可 /push 配置）
push:
  enabled: false
  time: "09:00"
  timezone: Asia/Shanghai

# 每个用户最大会话数
maxSessions: 1

# 覆盖模型（可选）
model: claude-sonnet-4-20250514

# 管理员
adminUsers:
  - "123456789"
```

## 会话 key

用户可在消息开头加 `#<key>` 选择会话编号，例如 `#2 继续刚才的话题`。不提供前缀时默认使用 key 0。

## 管理指令

已支持：

| 指令                 | 说明                                             |
| -------------------- | ------------------------------------------------ |
| `/reset [key]`       | 重置自己的对话（创建新会话）                     |
| `/reset [key] @user` | 重置他人对话（仅管理员）                         |
| `/reset all`         | 重置全群对话（仅管理员；仅影响已创建会话的用户） |
| `/model <name>`      | 切换群模型（仅管理员）                           |
| `/model default`     | 清除群配置 model 覆盖                            |
| `/push`              | 查看定时推送状态与用法（仅管理员）               |
| `/push on/off`       | 启用/关闭定时推送（仅管理员）                    |
| `/push time HH:MM`   | 设置推送时间（仅管理员）                         |
| `/login [token]`     | 保存 MCP token 到当前会话（不推荐在群里执行）    |
| `/logout`            | 从当前会话移除 MCP token                         |

仍在规划中：

| 指令                 | 说明                  |
| -------------------- | --------------------- |
| `/reload`            | 重载配置（规划）      |
| `/enable`            | 启用 AI               |
| `/disable`           | 禁用 AI               |
| `/status`            | 查看状态              |
| `/edit agent`        | 编辑 agent.md（规划） |
| `/edit skill <name>` | 编辑技能（规划）      |

## 最佳实践

1. **人设要具体**：越具体的人设，回复越一致
2. **提供示例**：在 agent.md 中提供对话示例
3. **设置边界**：明确 Agent 不能做什么
4. **迭代优化**：根据实际效果持续调整
5. **技能模块化**：将复杂功能拆分为独立技能

## 调试

### 查看日志

```bash
# 本地启动 adapter 后直接查看终端输出
bun run start:adapter
```

### 测试配置

测试指令仍在规划中。
