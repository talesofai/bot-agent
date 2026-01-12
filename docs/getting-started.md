# 快速开始

本指南帮助你完成环境准备，并验证 LuckyLilliaBot 可用性。

## 前置要求

- Docker 和 Docker Compose
- QQ 账号（用于机器人登录）
- OpenAI / Anthropic / Gemini API Key（任选其一）
- opencode CLI（仅在本机运行 Bot Agent 时需要）

## 步骤 1：克隆项目

```bash
git clone https://github.com/talesofai/opencode-bot-agent.git
cd opencode-bot-agent
```

## 步骤 2：配置环境变量

复制非敏感配置并初始化 Secret：

```bash
cp configs/example.env configs/.env
./scripts/init-secrets.sh
export CONFIG_PATH=configs/.env
```

编辑 `configs/.env`：

```env
# 可选：自定义模型
# OPENCODE_MODEL=claude-sonnet-4-20250514
```

编辑 `configs/secrets/.env`（只保留敏感项）：

```env
WEBUI_TOKEN=change-me
OPENAI_API_KEY=sk-xxx
# ANTHROPIC_API_KEY=sk-ant-xxx
# GEMINI_API_KEY=xxx
```

更多说明见 [Secret 管理指南](secrets.md)。

## 步骤 3：启动 LuckyLilliaBot

```bash
docker compose -f deployments/docker/docker-compose.yml up -d
```

## 步骤 4：扫码登录

打开 WebUI 进行登录（默认 Token 为 `change-me`）：

```
http://localhost:3080
```

如果需要查看 LuckyLilliaBot 日志获取二维码：

```bash
docker compose -f deployments/docker/docker-compose.yml logs luckylillia
```

使用 QQ 扫码登录。登录成功后，session 会被持久化。

## 步骤 5：测试

在 QQ 群中 @机器人 发送消息，确认机器人在线。AI 回复依赖 `opencode-bot-agent` 服务正常运行（当前 `docker-compose.yml` 仅启动 LuckyLilliaBot，需要单独启动 Bot Agent）。

你可以在消息开头加 `#<key>` 切换会话编号，例如 `#2 继续刚才的话题`。不提供前缀时默认使用 key 0。

如果你在本机直接运行 `opencode-bot-agent`（非 Docker 网络），请先把 `configs/.env` 中的 `MILKY_URL` 改为 `ws://localhost:3000`、`REDIS_URL` 改为 `redis://localhost:6379`，确认 `PLATFORM=qq`，然后在另一个终端启动：

```bash
set -a
source configs/secrets/.env
set +a
CONFIG_PATH=configs/.env bun run dev
```

本地运行需要 `opencode` CLI 已安装并可从 `PATH` 访问。

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
docker compose -f deployments/docker/docker-compose.yml logs -f luckylillia
```
