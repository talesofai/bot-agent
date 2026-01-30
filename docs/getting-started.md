# 快速开始

本指南帮助你完成环境准备，并验证 LuckyLilliaBot 可用性。

## 前置要求

- Docker 和 Docker Compose
- QQ 账号（用于机器人登录）
- 可选：OpenAI-compatible API Key（仅外部模式需要）
- 可选：opencode server（仅在本机运行 Bot Agent 时需要）

## 步骤 1：克隆项目

```bash
git clone https://github.com/talesofai/opencode-bot-agent.git
cd opencode-bot-agent
```

## 步骤 2：配置环境变量

复制配置（单一 `.env`）：

```bash
cp configs/example.env configs/.env
# 可选：如需自定义 .env 路径，可设置 CONFIG_PATH
# export CONFIG_PATH=configs/.env
```

编辑 `configs/.env`：

```env
# LuckyLilliaBot WebUI token（不要留空）
WEBUI_TOKEN=change-me

# 启用 QQ（必须显式设置；否则默认不启用 QQ）
LLBOT_PLATFORM=qq

# opencode server（Docker Compose 默认已包含；本机直跑需要自行启动并填 URL）
OPENCODE_SERVER_URL=http://opencode-server:4096

# 外部模式（可选；三项都非空才启用）
OPENAI_BASE_URL=
OPENAI_API_KEY=
OPENCODE_MODELS=

# 可选：默认 true（全工具/全权限 allow）；设为 false 可降低 opencode agent 权限
OPENCODE_YOLO=true
```

更多说明见 [Secret 管理指南](secrets.md)。

## 步骤 3：启动 LuckyLilliaBot

```bash
docker compose -f deployments/docker/docker-compose.llbot-local.yml up -d
```

## 步骤 4：扫码登录

打开 WebUI 进行登录（默认 Token 为 `change-me`）：

```
http://localhost:3080
```

如果需要查看 LuckyLilliaBot 日志获取二维码：

```bash
docker compose -f deployments/docker/docker-compose.llbot-local.yml logs luckylillia
```

使用 QQ 扫码登录。登录成功后，session 会被持久化。

## 步骤 5：测试

在 QQ 群中 @机器人 发送消息，确认机器人在线。AI 回复依赖 `opencode-bot-agent` 服务正常运行。

你可以在消息开头加 `#<key>` 切换会话编号，例如 `#2 继续刚才的话题`。不提供前缀时默认使用 key 0。

如果你在本机直接运行 `opencode-bot-agent`（非 Docker 网络），请先确保 Redis 与 PostgreSQL 可用，并让本地 llbot 将自己的 WS 地址注册到 Redis（例如 `ws://localhost:3000`）。然后在 `configs/.env` 中设置 `REDIS_URL=redis://localhost:6379` 与 `DATABASE_URL=postgres://...`（启用 QQ 需要显式设置 `LLBOT_PLATFORM=qq`；配置 `DISCORD_TOKEN` 时会同时启用 Discord）。注意：本项目默认不在运行时执行 DDL，请先在数据库执行迁移脚本创建/升级 `history_entries`：

```bash
psql "$DATABASE_URL" -f deployments/docker/postgres-init/001-history-entries.sql
```

完成后再在两个终端分别启动 Adapter 与 Worker：

```bash
# 终端 0：启动 opencode server（默认端口 4096）
OPENCODE_SERVER_PASSWORD=... \\
opencode serve --hostname 127.0.0.1 --port 4096 \\
  --cors https://app.opencode.ai \\
  --cors https://opencode.ai

# 终端 1
CONFIG_PATH=configs/.env bun run start:adapter

# 终端 2
CONFIG_PATH=configs/.env bun run start:worker
```

本地运行需要 `opencode` 已安装（用于启动 `opencode serve`）。

如果你需要在浏览器里查看 opencode sessions：

- 先确保 server 启动时允许 CORS（上面的 `--cors https://app.opencode.ai` 已包含）
- 然后打开 `https://app.opencode.ai`，按页面提示 attach 到 `http://localhost:4096`

可选：验证本地连通性（WebUI + Milky）：

```bash
WEBUI_TOKEN=your-token ./scripts/verify-local.sh
```

## 下一步

- [配置群 Agent](agent-customization.md) - 自定义群机器人人设
- [部署指南](deployment.md) - 生产环境部署
- [配置说明](configuration.md) - 完整配置项

## 常见问题

### Q: 扫码后登录失败？

检查网络环境，确保容器能访问 QQ 服务器。可能需要配置代理。

### Q: AI 不回复消息？

AI 回复可用性取决于 Bot Agent 是否已连接并完成配置。

### Q: 如何查看日志？

```bash
# 只看 LuckyLilliaBot
docker compose -f deployments/docker/docker-compose.llbot-local.yml logs -f luckylillia
```
