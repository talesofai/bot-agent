# 快速开始

本指南帮助你完成环境准备，并验证 LuckyLilliaBot 可用性。Bot Agent 的 TypeScript 实现仍在规划中。

## 前置要求

- Docker 和 Docker Compose
- QQ 账号（用于机器人登录）
- OpenAI / Anthropic / Gemini API Key（任选其一）

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

在 QQ 群中 @机器人 发送消息，确认机器人在线。AI 回复功能待 Bot Agent 实现后可用。

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

目前 Bot Agent 尚未实现，AI 回复不可用。可以先检查 LuckyLilliaBot 是否在线与登录成功。

### Q: 如何查看日志？

```bash
# 只看 LuckyLilliaBot
docker compose -f deployments/docker/docker-compose.yml logs -f luckylillia
```
