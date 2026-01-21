# 配置说明

本文档详细说明配置项。当前仓库包含 `configs/example.env`、`configs/default-agent.md` 与示例的 `configs/config.example.yaml`，热更新能力仍在迭代中。

## 配置方式

主配置当前仅支持 **环境变量 + 默认值**。`configs/config.example.yaml` 仅为结构示例，不会被程序读取。

默认会尝试加载 `configs/.env`；如需从其他文件加载环境变量，请设置 `CONFIG_PATH` 指向单一 `.env` 文件。
`CONFIG_PATH` 按项目根目录解析，避免使用绝对路径以便迁移。

## 环境变量

### SSRF 防护

统一在所有“URL 获取链路”上做 SSRF 防护（例如 Discord 外链图片抓取、`url-access-check`、以及脚本/工具的网络请求）：

```env
# 最大重定向次数（默认 3）
SSRF_MAX_REDIRECTS=3

# allowlist 预留但默认不启用
SSRF_ALLOWLIST_ENABLED=false
SSRF_ALLOWLIST_HOSTS=
```

### Opencode Server（HTTP）

Worker 通过 HTTP 调用 **常驻** 的 opencode server（而不是每条消息 `spawn opencode run`）。同一会话的串行由 Worker 侧的 Redis gate 保证。

```env
# opencode server 地址（K8s/Compose 通常是 Service 名称；本地可用 http://localhost:4096）
OPENCODE_SERVER_URL=http://opencode-server:4096

# 可选：opencode server Basic Auth（与 server 端 OPENCODE_SERVER_* 对齐）
OPENCODE_SERVER_USERNAME=opencode
OPENCODE_SERVER_PASSWORD=

# 请求超时（毫秒）
OPENCODE_SERVER_TIMEOUT_MS=600000
```

生产部署要点（避免“多副本不共享会话”）：

- opencode server 需要共享 `~/.local/share/opencode`（XDG data）与 `~/.config/opencode`（XDG config）；推荐把 `HOME` 指到 RWX 共享卷（例如 `/data/opencode-home`）
- Worker 传入的 `x-opencode-directory` 必须在 opencode server 容器内可访问（因此 server 也要挂载同一份 `/data`）

查看 sessions（Web UI）：

- opencode 官方提供 Web 客户端 `https://app.opencode.ai`，可 attach 到你部署的 opencode server 查看 sessions。
- server 需要允许该域名的 CORS；本仓库的 Compose/K8s 示例已在 `opencode serve` 启动参数中加入：
  - `--cors https://app.opencode.ai`
  - `--cors https://opencode.ai`
- 若你自行启动 server，请确保也带上以上 `--cors` 参数（以及生产环境务必设置 `OPENCODE_SERVER_PASSWORD`）。
- Web UI 通过 `GET /session?directory=<当前项目 worktree>` 列出 sessions，按 `directory` **精确匹配**。本仓库 K8s 示例会在启动时创建 `/data` project 并将历史 sessions 迁移为 `directory=/data`，确保能看到所有 sessions。

### Opencode 模型模式

默认模式下，Bot Agent **不需要任何 API Key**，并强制使用 opencode 自带的 `opencode/glm-4.7-free`。

如需接入 LiteLLM / OpenAI-compatible endpoint，仅在 **以下三项都非空** 时启用外部模式：

```env
OPENAI_BASE_URL=https://litellm.example.com/v1
OPENAI_API_KEY=sk-xxx
OPENCODE_MODELS=gpt-5.2,gpt-5.1
```

- `OPENCODE_MODELS` 为逗号分隔的 litellm 模型 ID（允许包含 `/`，例如 `ark/glm-4.7`），内部会拼为 `litellm/<id>` 传给 opencode。
- 群配置里的 `model` 仅在外部模式生效，且必须在 `OPENCODE_MODELS` 白名单内。
- `OPENCODE_YOLO` 默认开启（true）：Worker 会在请求里显式开启必要工具（bash/read/write/webfetch...）。如需降低权限，可设置为 `false/0`（不再显式开启工具）。
- 外部模式下会自动给 LiteLLM 请求附带追踪头，便于和网关/上游日志串联：
  - `traceparent`（W3C Trace Context）
  - `x-opencode-trace-id`（与 `telemetry.span` 的 `traceId` 相同）

> 注意：`OPENAI_BASE_URL/OPENAI_API_KEY` 等 provider/auth 配置由 opencode server 实际使用；Worker 侧主要用于判断“外部模式是否启用”与 `OPENCODE_MODELS` 白名单校验。

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
> Discord Slash Commands（`/reset`、`/resetall`、`/model`、`/ping`、`/help`）需要额外配置 `DISCORD_APPLICATION_ID`（Discord 应用 ID），否则会跳过注册。
> 管理指令 `/model` 会读取 `OPENCODE_MODELS` 白名单，请确保 Adapter 进程也注入了该环境变量。

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

### 历史上下文

Worker 构建提示词时会把历史拆成两段，避免“别的群的记录把当前群窗口挤掉”：

- 群窗口：当前群最近 N 条（包含其他人发给 bot、以及 bot 的回复）；私聊（`groupId=0`）会自动按 `userId` 过滤，避免不同用户私聊串台
- 跨群记忆：当前用户在其他群/私聊与 bot 的最近 N 条（默认不包含当前群，避免重复）

```env
# 群窗口：当前群最近 N 条（默认 30）
HISTORY_GROUP_WINDOW_MAX_ENTRIES=30

# 跨群记忆：当前用户在其他群/私聊最近 N 条（默认 20）
HISTORY_USER_MEMORY_MAX_ENTRIES=20

# 历史总字节上限（默认 200000）
HISTORY_MAX_BYTES=200000
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
每个 `{userId}` 目录下会维护 `index.json`（会话槽位 `key` -> 当前 `sessionId` 映射），用于支持 `/reset` 创建新会话并与旧会话隔离上下文。

### 日志配置

```env
# 日志级别: debug, info, warn, error
LOG_LEVEL=info

# 日志格式: json, pretty
LOG_FORMAT=json

# Telemetry：结构化 span 日志（用于阿里云日志/SLS 侧做链路耗时分析）
# 开启后会输出 event=telemetry.span，并包含 traceId/phase/step/startedAt/durationMs 等字段
TELEMETRY_ENABLED=true

# 采样率（0~1），按 traceId 稳定采样；1 表示全量
TELEMETRY_SAMPLE_RATE=1
```

### 链路追踪（ARMS / OpenTelemetry）

如需在 ARMS Trace 里查看端到端链路（并与 LiteLLM 的 span 串联），需要启用 OTLP traces 导出：

```env
# OTLP HTTP/Protobuf traces endpoint（建议与 LiteLLM 使用同一个 ARMS workspace）
OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=http://tracing-analysis-xxx.aliyuncs.com/<adapt_xxx>/api/otlp/traces

# 服务名（建议区分 adapter/worker 与 region）
OTEL_SERVICE_NAME=opencode-bot-agent-worker-sg
```

> 注意：如果 LiteLLM 在上海 workspace，而 bot 上报到新加坡 workspace，你只能两边各搜一次 `traceId`，无法在同一条 trace 视图里合并。

### MCP 配置

```env
# talesofai MCP Server 地址
MCP_TALESOFAI_URL=https://mcp.talesofai.cn/mcp

# talesofai MCP 鉴权 token（请求头 x-token）
# - 可直接在环境变量里配置（推荐）
# - 或使用 /login 写入“当前会话”并在会话内覆盖
# 注意：在 opencode server 模式下，NIETA_TOKEN 需要注入到 **opencode server 容器** 的环境变量中，供 MCP header 模板 `{env:NIETA_TOKEN}` 读取。
NIETA_TOKEN=

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
triggerMode: keyword # 触发方式: mention | keyword（keyword 为“前缀匹配”）
keywords: # keyword 模式的触发词（群级）
  - "小助手"
  - "机器人"
keywordRouting: # 关键词路由开关（群级）
  enableGlobal: true # 是否响应全局关键词
  enableGroup: true # 是否响应群关键词
  enableBot: true # 是否允许机器人关键词
echoRate: null # 复读概率（0-100），空为继承上一级
maxSessions: 1 # 每个用户最大会话数
model: glm-4.7 # 可选：仅外部模式生效，且必须在 OPENCODE_MODELS 白名单内；也可用 /model 管理指令切换

# 定时热点推送（默认不启用；管理员可 /push 配置）
push:
  enabled: false
  time: "09:00"
  timezone: Asia/Shanghai

# 管理员配置
adminUsers:
  - "123456789" # QQ 号
  - "987654321"
```

关键词路由规则：全局/群关键词由群内所有 Bot 回复；机器人关键词仅对应 Bot 回复。
群级开关由 `keywordRouting` 控制，机器人级开关可在机器人配置中进一步细化。
复读概率 `echoRate` 由 bot > group > global 依次回退，空值代表继承。

群聊入队规则：仅在 **@Bot** / **关键词前缀** / **回复 Bot 消息** 三种情况下触发 AI 处理；其中 `triggerMode=keyword` 时关键词为“前缀匹配”（大小写不敏感）。

### 全局关键词配置

```yaml
# /data/router/global.yaml
keywords:
  - "奈塔"
  - "小捏"
echoRate: 0
```

> 首次启动时若 `router/global.yaml` 不存在，Adapter 会自动创建默认文件（默认唤醒词关键词 + `echoRate=0`），方便运维直接改文件生效。

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
