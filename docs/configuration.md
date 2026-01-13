# 配置说明

本文档详细说明配置项。当前仓库包含 `configs/example.env`、`configs/default-agent.md` 与占位的 `configs/config.yaml`，热更新能力仍在迭代中。

## 配置方式

主配置当前仅支持 **环境变量 + 默认值**。`configs/config.yaml` 为占位模板，读取逻辑仍在规划中。

如需从文件加载环境变量，请设置 `CONFIG_PATH` 指向单一 `.env` 文件（例如 `configs/.env`）。
`CONFIG_PATH` 按项目根目录解析，避免使用绝对路径以便迁移。

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

上述敏感项需在运行进程的环境中可见，可合并到 `CONFIG_PATH` 指向的 `.env` 文件，或在启动前额外导出 `configs/secrets/.env`。

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
# 平台选择: qq | discord
PLATFORM=qq

# llbot Redis 注册表前缀
LLBOT_REGISTRY_PREFIX=llbot:registry

# 注册 TTL（秒）
LLBOT_REGISTRY_TTL_SEC=30

# 注册刷新间隔（秒）
LLBOT_REGISTRY_REFRESH_SEC=10

# Discord 平台配置（规划）
DISCORD_TOKEN=
DISCORD_APPLICATION_ID=

# WebSocket 重连配置（当前使用内置默认值）
```

> `SERVICE_ROLE=worker` 时可不提供平台连接配置；否则 `PLATFORM=qq` 需要 Redis 注册表可用，`PLATFORM=discord` 必须提供 `DISCORD_TOKEN`。
>
> Discord Adapter 当前仍是占位实现，`SERVICE_ROLE=adapter/all` 且 `PLATFORM=discord` 时会直接报错。

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

# 可选：/health 版本号（默认读取 npm_package_version）
APP_VERSION=
```

### 群管理配置

```env
# 群数据目录
GROUPS_DATA_DIR=/data/groups

# 数据根目录（用于 router/bots 等）
DATA_DIR=/data
```

`GROUPS_DATA_DIR` 必须指向持久化路径，避免容器重启后丢失群配置与会话历史。

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

# llbot Redis 注册表配置
llbotRegistry:
  prefix: ${LLBOT_REGISTRY_PREFIX:-llbot:registry}
  ttlSeconds: ${LLBOT_REGISTRY_TTL_SEC:-30}
  refreshSeconds: ${LLBOT_REGISTRY_REFRESH_SEC:-10}

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

## 可用技能（规划）

- 闲聊对话
- 问答解答
```

## 群目录结构

每个群有独立的配置目录：

```
/data/groups/{group_id}/
├── agent.md          # 群 Agent 人设（覆盖默认）
├── config.yaml       # 群配置
├── skills/           # 群技能（默认技能规划中）
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

> 注意：群目录需要预先创建（或由运维脚本创建）。目录不存在时不会自动初始化，也不会触发消息入队。

### 继承与覆盖规则

- 群目录初始化或修复时若缺少 `agent.md` 会生成默认内容。
- 通用技能仍在规划中，目前仅加载群目录下的 `skills/`。

### 群配置 config.yaml

```yaml
# 群特定配置
enabled: true # 是否启用 AI 回复
triggerMode: mention # 触发方式: mention | keyword
keywords: # keyword 模式的触发词（群级）
  - "小助手"
  - "机器人"
keywordRouting: # 关键词路由开关（群级）
  enableGlobal: true # 是否响应全局关键词
  enableGroup: true # 是否响应群关键词
  enableBot: true # 是否允许机器人关键词
maxSessions: 1 # 每个用户最大会话数
model: claude-sonnet-4-20250514 # 覆盖 OPENCODE_MODEL（可选）

# 管理员配置
adminUsers:
  - "123456789" # QQ 号
  - "987654321"
```

关键词路由规则：全局/群关键词由群内所有 Bot 回复；机器人关键词仅对应 Bot 回复。
群级开关由 `keywordRouting` 控制，机器人级开关可在机器人配置中进一步细化。

### 全局关键词配置

```yaml
# /data/router/global.yaml
keywords:
  - "生成图像"
  - "画图"
```

### 机器人关键词配置

```yaml
# /data/bots/{bot_id}/config.yaml
keywords:
  - "小布小布"
keywordRouting:
  enableGlobal: true # 是否响应全局关键词
  enableGroup: true # 是否响应群关键词
  enableBot: true # 是否使用机器人关键词
```

`bot_id` 为平台账号 ID（QQ 号或 Discord ID）。

## 配置热更新

### 支持热更新的配置

- 群目录下的 `agent.md`
- 群目录下的 `skills/*.md`
- 群目录下的 `config.yaml`

### 触发方式

1. **自动**：文件修改后自动重载（通过 chokidar）
2. **手动**：发送管理指令 `/reload`（规划中）

### 不支持热更新的配置

以下配置修改后需要重启服务：

- 环境变量
- （规划）`configs/config.yaml` 主配置
- API Key
