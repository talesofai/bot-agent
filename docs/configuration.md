# 配置说明

本文档详细说明配置项。当前仓库包含 `configs/example.env`、`configs/default-agent.md` 与示例的 `configs/config.example.yaml`，热更新能力仍在迭代中。

## 配置方式

主配置当前仅支持 **环境变量 + 默认值**。`configs/config.example.yaml` 仅为结构示例，不会被程序读取。

默认会尝试加载 `configs/.env`；如需从其他文件加载环境变量，请设置 `CONFIG_PATH` 指向单一 `.env` 文件。
`CONFIG_PATH` 按项目根目录解析，避免使用绝对路径以便迁移。

## 环境变量

### Opencode 模型模式

默认模式下，Bot Agent **不需要任何 API Key**，并强制使用 opencode 自带的 `opencode/glm-4.7-free`。

如需接入 LiteLLM / OpenAI-compatible endpoint，仅在 **以下三项都非空** 时启用外部模式：

```env
OPENAI_BASE_URL=https://litellm.example.com/v1
OPENAI_API_KEY=sk-xxx
OPENCODE_MODELS=gpt-5.2,gpt-5.1
```

- `OPENCODE_MODELS` 为逗号分隔的“裸模型名”，内部会拼为 `litellm/<name>` 传给 opencode。
- 群配置里的 `model` 仅在外部模式生效，且必须在 `OPENCODE_MODELS` 白名单内。
- `OPENCODE_YOLO` 默认开启（true）：使用内置 `chat-yolo-responder` agent（全工具/全权限 allow）。如需降低权限，可设置为 `false/0`（将不再显式指定 agent）。

### 连接配置

```env
# 平台启用
# 默认开启 QQ；配置 DISCORD_TOKEN 时同时启用 Discord

# llbot Redis 注册表前缀
LLBOT_REGISTRY_PREFIX=llbot:registry

# 注册 TTL（秒）
LLBOT_REGISTRY_TTL_SEC=30

# 注册刷新间隔（秒）
LLBOT_REGISTRY_REFRESH_SEC=10

# 注册器参数（仅 llbot 注册器使用）
LLBOT_REGISTRY_BOT_ID=
LLBOT_REGISTRY_WS_URL=
LLBOT_PLATFORM=qq

# Discord 平台配置（提供 token 即自动启用 Discord 适配器）
DISCORD_TOKEN=
DISCORD_APPLICATION_ID=

# WebSocket 重连配置（当前使用内置默认值）
```

> Adapter 进程默认连接 QQ 注册表；提供 `DISCORD_TOKEN` 时会同时连接 Discord。

### 队列配置

```env
# Redis 连接地址 (BullMQ Backend)
REDIS_URL=redis://localhost:6379
```

### 存储配置

```env
# PostgreSQL（历史与可变状态）
DATABASE_URL=postgres://postgres:postgres@postgres:5432/opencode
```

### HTTP 服务配置

```env
# HTTP 端口（Adapter）
HTTP_PORT=8080

# HTTP 端口（Worker；0 表示随机端口）
WORKER_HTTP_PORT=8081

# 可选：管理端点鉴权 token（未设置则禁用管理接口）
API_TOKEN=

# 强制群聊 groupId 覆盖（高级选项：会让多个群共享同一套群配置/会话目录；私聊始终 groupId=0；未设置则使用消息 guildId）
# FORCE_GROUP_ID=1

# 可选：/health 版本号（默认读取 npm_package_version）
APP_VERSION=
```

### 群管理配置

```env
# 群数据目录
GROUPS_DATA_DIR=/data/groups

# 数据根目录（用于 router/bots 等）
DATA_DIR=/data

# Bot ID 映射（可选，格式 alias:canonical，用逗号分隔）
BOT_ID_ALIASES=
```

`GROUPS_DATA_DIR` 必须指向持久化路径，避免容器重启后丢失群配置。
会话数据默认存放在 `${GROUPS_DATA_DIR}/sessions/{botId}/{groupId}/{userId}/{sessionId}`，其中 `botId` 为 `{platform}-{canonicalBotId}`（canonical 部分由 `BOT_ID_ALIASES` 解析）。

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

### configs/config.example.yaml（示例）

该文件仅用于展示主配置结构，**不会被程序读取**。为避免误用，示例文件名明确带 `example`。

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
  model: opencode/glm-4.7-free

# 群配置
groups:
  dataDir: ${GROUPS_DATA_DIR:-/data/groups}

# 数据根目录
data:
  dir: ${DATA_DIR:-/data}

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
└── assets/           # 群资源
    └── images/
```

> 注意：群目录不存在时，Bot Agent 会在首次收到消息时自动创建并初始化（生成默认 `agent.md`/`config.yaml` 与必要子目录），并继续处理消息。为了更可控的运维（权限、预置配置等），仍建议由运维提前创建并填充自定义内容。

## bot 账号标识与路由

### bot_account_id 规则

```
{platform}:{account_id}
```

示例：`qq:12345678`、`discord:987654321`

### Redis 路由

```
HSET bot:route:{bot_account_id} llbot_ordinal 3 ws_url ws://llbot-3... updated_at ...
EXPIRE bot:route:{bot_account_id} 30
```

数据库不保存 llbot 路由信息。

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
echoRate: null # 复读概率（0-100），空为继承上一级
maxSessions: 1 # 每个用户最大会话数
model: gpt-5.2 # 可选：仅外部模式生效，且必须在 OPENCODE_MODELS 白名单内（裸模型名）

# 管理员配置
adminUsers:
  - "123456789" # QQ 号
  - "987654321"
```

关键词路由规则：全局/群关键词由群内所有 Bot 回复；机器人关键词仅对应 Bot 回复。
群级开关由 `keywordRouting` 控制，机器人级开关可在机器人配置中进一步细化。
复读概率 `echoRate` 由 bot > group > global 依次回退，空值代表继承。

### 全局关键词配置

```yaml
# /data/router/global.yaml
keywords:
  - "生成图像"
  - "画图"
echoRate: 30
```

> 首次启动时若 `router/global.yaml` 不存在，Adapter 会自动创建默认文件（空关键词 + `echoRate=30`），方便运维直接改文件生效。

### 机器人关键词配置

```yaml
# /data/bots/{botId}/config.yaml
keywords:
  - "小布小布"
keywordRouting:
  enableGlobal: true # 是否响应全局关键词
  enableGroup: true # 是否响应群关键词
  enableBot: true # 是否使用机器人关键词
echoRate: null # 复读概率（0-100），空为继承上一级
```

`botId` 为 `{platform}-{canonicalBotId}`，与会话目录中的 `botId` 一致（canonical 部分由 `BOT_ID_ALIASES` 解析，例如 `qq-123456` / `discord-987654`）。

> 当某个 Bot 第一次参与消息分发（收到消息）时，Adapter 会自动创建 `/data/bots/{botId}/config.yaml` 默认文件（空关键词 + 全开 `keywordRouting`），之后可直接编辑该文件进行机器人级路由配置。

### Opencode Skills 覆盖（可选）

Bot Agent 每次启动 opencode 前，会把技能目录同步到会话工作区的 `.claude/skills/`。目录与优先级如下（同名 skill 以后者覆盖前者）：

1. 内置：`configs/skills/`（必须存在）
2. 全局覆盖：`/data/global/skills/`
3. 群覆盖：`/data/groups/{group_id}/skills/`（`groupId=0` 时跳过）
4. 机器人覆盖：`/data/bots/{botId}/skills/`

这里的 skill 目录结构为 `{skillName}/SKILL.md` + `{skillName}/scripts/*`。

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
- `configs/config.example.yaml`（示例；未启用读取）
- API Key
