# Secret 管理指南

本仓库为 public，任何真实 secret 都不应提交。以下流程确保开发体验友好且不会泄漏敏感信息。

## 总则

- 只提交模板文件，不提交真实 secret。
- 本地与集群的真实 secret 由开发者自行创建。
- 避免把 `WEBUI_TOKEN`、API Key 等写进源码或公开配置。

## 文件约定

单一来源的 secret 模板为 `configs/secrets/.env.example`，所有环境从该文件派生：

- 本地环境：`configs/secrets/.env`（真实值，不提交）
- 本地模板：`configs/secrets/.env.example`（提交）
- K8s Secret：`deployments/k8s/llbot-secret.yaml`（真实值，不提交，由脚本生成）

上述真实文件均已在 `.gitignore` 中忽略。

## 快速初始化

```bash
./scripts/init-secrets.sh
```

会生成：

- `configs/secrets/.env`
- `deployments/k8s/llbot-secret.yaml`

如果想覆盖已有文件：

```bash
./scripts/init-secrets.sh --force
```

## 快速轮换

同时更新本地与 K8s 的 `WEBUI_TOKEN`：

```bash
WEBUI_TOKEN=your-token ./scripts/rotate-secrets.sh
```

## 本地 / Docker 使用

编辑 `configs/secrets/.env`，设置真实值，例如：

```env
WEBUI_TOKEN=your-token
OPENAI_API_KEY=sk-xxx
DISCORD_TOKEN=your-token
DISCORD_APPLICATION_ID=your-app-id
DATABASE_URL=postgres://postgres:postgres@postgres:5432/opencode
API_TOKEN=your-token
```

`API_TOKEN` 预留给 Bot Agent API 认证（规划中）。

如果你通过 dotenv 加载环境变量，可以将 secrets 合并到 `CONFIG_PATH` 指向的单一文件（推荐 `configs/.env`），或在启动前手动导出 `configs/secrets/.env`：

```bash
export CONFIG_PATH=configs/.env
```

例如：

```bash
set -a
source configs/secrets/.env
set +a
```

运行时注入（Docker Compose 会直接导出环境变量，无需 `CONFIG_PATH`）：

```bash
docker compose -f deployments/docker/docker-compose.yml up -d
```

## Kubernetes 使用

1. 生成 K8s Secret 清单：

```bash
./scripts/generate-k8s-secret.sh
```

2. 应用 Secret：

```bash
  kubectl apply -f deployments/k8s/llbot-secret.yaml
```

## 误提交防护

仓库预留了 `gitleaks` 扫描（当前未启用），可在 CI 中开启以检测泄漏。

如需定制扫描规则，可新增 `.gitleaks.toml`。
