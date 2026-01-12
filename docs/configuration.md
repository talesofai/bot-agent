# 配置说明

本文档详细说明配置项。当前仓库包含 `configs/example.env`、`configs/default-agent.md` 与占位的 `configs/config.yaml`，热更新能力仍在迭代中。

## 配置方式

Bot Agent 支持三种配置方式（优先级从高到低）：

1. **环境变量**
2. **配置文件** (`configs/config.yaml`)
3. **默认值**

如需从文件加载环境变量，请设置 `CONFIG_PATH` 指向单一 `.env` 文件（例如 `configs/.env`）。

## 环境变量

### AI 模型配置（敏感）

```env
# OpenAI
OPENAI_API_KEY=sk-xxx

# Anthropic
ANTHROPIC_API_KEY=sk-ant-xxx

# Google Gemini
GEMINI_API_KEY=xxx
```

上述敏感项应合并到 `CONFIG_PATH` 指向的 `.env` 文件中。

### AI 模型配置（非敏感）

```env
# 可选，自定义 endpoint
OPENAI_BASE_URL=https://api.openai.com/v1

# 模型选择
OPENCODE_MODEL=claude-sonnet-4-20250514
```

上述非敏感项同样写入 `CONFIG_PATH` 指向的 `.env` 文件中。

### 连接配置

```env
# LuckyLilliaBot Milky API 地址
MILKY_URL=http://localhost:3000

# WebSocket 重连配置（当前使用内置默认值）
```

### 队列配置

```env
# Redis 连接地址 (BullMQ Backend)
REDIS_URL=redis://localhost:6379

# 服务角色: all | adapter | worker
SERVICE_ROLE=all
```

### HTTP 服务配置

```env
# HTTP 端口
HTTP_PORT=8080

# 入口默认群 ID (未提供时使用消息 channelId)
DEFAULT_GROUP_ID=
```

### 群管理配置

```env
# 群数据目录
GROUPS_DATA_DIR=/data/groups
```

### 日志配置

```env
# 日志级别: debug, info, warn, error
LOG_LEVEL=info

# 日志格式: json, pretty
LOG_FORMAT=json
```

### MCP 配置

```env
# talesofai MCP Server 地址
MCP_TALESOFAI_URL=http://mcp.talesofai.com

```

## 配置文件

### configs/config.yaml（规划）

```yaml
# 服务配置
server:
  host: 0.0.0.0
  port: 8080

# Milky 连接配置
milky:
  url: ${MILKY_URL}

# Agent 配置
agent:
  model: ${OPENCODE_MODEL:-claude-sonnet-4-20250514}

# 群配置
groups:
  dataDir: ${GROUPS_DATA_DIR:-/data/groups}

# MCP 配置
mcp:
  servers:
    talesofai:
      url: ${MCP_TALESOFAI_URL}

# 日志配置
logging:
  level: ${LOG_LEVEL:-info}
  format: ${LOG_FORMAT:-json}
```

### configs/default-agent.md

新群的默认 Agent 配置：

```markdown
# 默认 Agent 配置

你是一个友好的 QQ 群助手。

## 行为准则

1. 礼貌友好地回复群成员的消息
2. 如果不确定，诚实地说不知道
3. 避免敏感话题

## 可用技能

- 闲聊对话
- 问答解答
```

## 群目录结构

每个群有独立的配置目录：

```
/data/groups/{group_id}/
├── agent.md          # 群 Agent 人设（覆盖默认）
├── config.yaml       # 群配置（可选）
├── skills/           # 群技能（同名覆盖默认技能，新增为扩展）
│   ├── draw.md
│   └── roleplay.md
├── sessions/         # 用户会话
│   └── {user}-{key}/
│       ├── history.jsonl
│       ├── meta.json
│       └── workspace/
└── assets/           # 群资源
    └── images/
```

### 继承与覆盖规则

- 群目录若缺少 `agent.md` 会自动生成默认内容。
- 通用技能（规划）与群目录下的 `skills/` 合并加载，同名文件覆盖默认技能，新增文件直接生效。

### 群配置 config.yaml

```yaml
# 群特定配置
enabled: true # 是否启用 AI 回复
triggerMode: mention # 触发方式: mention, keyword, all
keywords: # keyword 模式的触发词
  - "小助手"
  - "机器人"
cooldown: 5 # 消息冷却时间（秒）
maxSessions: 1 # 每个用户最大会话数
model: claude-sonnet-4-20250514 # 覆盖 OPENCODE_MODEL（可选）

# 管理员配置
adminUsers:
  - 123456789 # QQ 号
  - 987654321
```

## 配置热更新（规划）

### 支持热更新的配置

- 群目录下的 `agent.md`
- 群目录下的 `skills/*.md`
- 群目录下的 `config.yaml`

### 触发方式

1. **自动**：文件修改后自动重载（通过 fsnotify）
2. **手动**：发送管理指令 `/reload`

### 不支持热更新的配置

以下配置修改后需要重启服务：

- 环境变量
- `configs/config.yaml` 主配置
- API Key
