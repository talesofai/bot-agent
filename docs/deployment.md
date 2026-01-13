# 部署指南

本文档介绍生产环境部署方案。部分部署细节仍在迭代中。

## 部署方式

| 方式           | 适用场景         | 复杂度 |
| -------------- | ---------------- | ------ |
| Docker Compose | 单机、开发测试   | ⭐     |
| Kubernetes     | 生产环境、多实例 | ⭐⭐⭐ |

LuckyLilliaBot 可稳定部署，Bot Agent 已提供基础能力但部署细节仍在迭代。

## Docker Compose 部署（基础可用）

### 目录结构

```
/opt/opencode-bot-agent/
├── deployments/
│   └── docker/
│       └── docker-compose.yml
├── configs/
│   ├── .env
│   └── secrets/
│       └── .env
└── data/
    ├── llbot/          # LuckyLilliaBot (LLBot) 数据
    └── groups/         # 群数据
```

### docker-compose.yml

当前仅启用 LuckyLilliaBot（LLBot Docker 版），Bot Agent 以注释方式保留占位。

```yaml
version: "3.8"

services:
  redis:
    image: redis:7.4-alpine
    container_name: opencode-redis
    restart: unless-stopped
    command: ["redis-server", "--appendonly", "yes"]
    ports:
      - "6379:6379"
    volumes:
      - ../../data/redis:/data

  pmhq:
    image: linyuchen/pmhq:latest
    container_name: luckylillia-pmhq
    restart: unless-stopped
    privileged: true
    environment:
      - ENABLE_HEADLESS=false
      - AUTO_LOGIN_QQ=
    volumes:
      - ../../data/llbot/qq:/root/.config/QQ
      - ../../data/llbot/data:/app/llbot/data

  luckylillia:
    image: linyuchen/llbot:latest
    container_name: luckylillia
    restart: unless-stopped
    env_file:
      - ../../configs/.env
      - ../../configs/secrets/.env
    environment:
      - ENABLE_WEBUI=true
      - WEBUI_PORT=3080
    entrypoint:
      - /bin/sh
      - /config/llbot-entrypoint.sh
    ports:
      - "3000:3000"
      - "3080:3080"
    extra_hosts:
      - "host.docker.internal:host-gateway"
    volumes:
      - ../../data/llbot/data:/app/llbot/data
      - ../../data/llbot/qq:/root/.config/QQ
      - ../../data/llbot/default_config.json:/config/default_config.json:ro
      - ../../scripts/llbot-entrypoint.sh:/config/llbot-entrypoint.sh:ro
    depends_on:
      - pmhq

  # opencode-bot-agent:
  #   image: ghcr.io/talesofai/opencode-bot-agent:latest # 镜像占位
  #   container_name: opencode-bot-agent
  #   restart: unless-stopped
  #   depends_on:
  #     - luckylillia
  #   volumes:
  #     - ../../data:/data
  #     - ../../configs:/app/configs
  #   env_file:
  #     - ../../configs/.env
  #     - ../../configs/secrets/.env
  #   environment:
  #     - PLATFORM=qq
  #     - REDIS_URL=redis://redis:6379
  #     - LLBOT_REGISTRY_PREFIX=llbot:registry
  #     - DISCORD_TOKEN=your-token # 规划
  #     - DISCORD_APPLICATION_ID=your-app-id # 规划
```

当前使用公开镜像 `linyuchen/pmhq` 与 `linyuchen/llbot`。
注意：**Redis 是由于引入分布式任务队列（BullMQ）而必须的服务**，请确保它在 Agent 启动前已就绪。

### 启动命令

```bash
cd /opt/opencode-bot-agent
docker compose -f deployments/docker/docker-compose.yml up -d
```

## Kubernetes 部署（规划）

当前仓库已提供 `deployments/k8s/` 目录，主要覆盖 LuckyLilliaBot/PMHQ 基础资源，Bot Agent 需结合后文示例单独部署：

- `deployments/k8s/bot-namespace.yaml`
- `deployments/k8s/llbot-pvc.yaml`
- `deployments/k8s/llbot-configmap.yaml`
- `deployments/k8s/pmhq-deployment.yaml`
- `deployments/k8s/llbot-deployment.yaml`
- `deployments/k8s/llbot-service.yaml`
- `deployments/k8s/redis.yaml`

## Secret 管理（推荐）

本仓库为 public，任何 secret 都不应提交。统一使用 `configs/secrets/.env` 与 `deployments/k8s/llbot-secret.yaml`：

### Docker / 本地

```bash
./scripts/init-secrets.sh
```

设置 `WEBUI_TOKEN` 等敏感项后，直接启动（`WEBUI_TOKEN` 不能为空，否则脚本拒绝生成 Secret）：

```bash
docker compose -f deployments/docker/docker-compose.yml up -d
```

### Kubernetes

复制示例并创建真实 Secret：

```bash
./scripts/generate-k8s-secret.sh
kubectl apply -f deployments/k8s/llbot-secret.yaml
```

`deployments/k8s/llbot-secret.yaml` 已被 `.gitignore` 排除，避免误提交。

完整说明见 [Secret 管理指南](secrets.md)。

### 命名空间

```yaml
# deployments/k8s/bot-namespace.yaml
apiVersion: v1
kind: Namespace
metadata:
  name: bot
```

### Secret（API Keys）

```yaml
# deployments/k8s/llbot-secret.yaml（由 scripts/generate-k8s-secret.sh 生成）
apiVersion: v1
kind: Secret
metadata:
  name: llbot-secrets
  namespace: bot
type: Opaque
stringData:
  WEBUI_TOKEN: ""
  OPENAI_API_KEY: ""
  ANTHROPIC_API_KEY: ""
  GEMINI_API_KEY: ""
  API_TOKEN: "" # 预留给 Bot Agent API 认证
```

### PersistentVolumeClaim

```yaml
# deployments/k8s/llbot-pvc.yaml
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: bot-data
  namespace: bot
spec:
  accessModes:
    - ReadWriteOnce
  resources:
    requests:
      storage: 10Gi
```

### LLBot Deployment

LLBot 仅负责 QQ 客户端与 WebUI。主服务通过 Redis 注册表发现 llbot，并建立 WS 连接；每个 llbot Pod 内需要运行注册器定期写入 `llbot:registry:{botId}`。为了允许主服务直连，`onlyLocalhost` 必须关闭。建议将 `/data` 挂载为 RWX（NAS），用于 `groups/`、`router/`、`bots/`。

注册器可直接运行本仓库脚本（示例）：

```bash
LLBOT_REGISTRY_BOT_ID=123 \
LLBOT_REGISTRY_WS_URL=ws://llbot-0-headless:3000 \
LLBOT_REGISTRY_TTL_SEC=30 \
LLBOT_REGISTRY_REFRESH_SEC=10 \
bun run llbot:registrar
```

```yaml
# deployments/k8s/llbot-deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: luckylillia
  namespace: bot
spec:
  replicas: 1
  selector:
    matchLabels:
      app: luckylillia
  template:
    metadata:
      labels:
        app: luckylillia
    spec:
      containers:
        - name: luckylillia
          image: linyuchen/llbot:latest
---
见 `deployments/k8s/llbot-service.yaml`。
```

### Bot Agent Deployment

Adapter 与 Worker 分离部署，入口命令分别为 `start:adapter` / `start:worker`。

```yaml
# deployments/k8s/opencode-bot-agent-adapter.yaml（示例）
apiVersion: apps/v1
kind: Deployment
metadata:
  name: opencode-bot-agent-adapter
  namespace: bot
spec:
  replicas: 1
  selector:
    matchLabels:
      app: opencode-bot-agent-adapter
  template:
    metadata:
      labels:
        app: opencode-bot-agent-adapter
    spec:
      containers:
        - name: opencode-bot-agent-adapter
          image: ghcr.io/opencode-bot-agent/opencode-bot-agent:latest
          command: ["bun", "run", "start:adapter"]
          env:
            - name: PLATFORM
              value: "qq"
            - name: REDIS_URL
              value: "redis://redis:6379"
            - name: LLBOT_REGISTRY_PREFIX
              value: "llbot:registry"
            - name: OPENAI_API_KEY
              valueFrom:
                secretKeyRef:
                  name: llbot-secrets
                  key: OPENAI_API_KEY
          volumeMounts:
            - name: data
              mountPath: /data
      volumes:
        - name: data
          persistentVolumeClaim:
            claimName: bot-data
---
# deployments/k8s/opencode-bot-agent-worker.yaml（示例）
apiVersion: apps/v1
kind: Deployment
metadata:
  name: opencode-bot-agent-worker
  namespace: bot
spec:
  replicas: 1
  selector:
    matchLabels:
      app: opencode-bot-agent-worker
  template:
    metadata:
      labels:
        app: opencode-bot-agent-worker
    spec:
      containers:
        - name: opencode-bot-agent-worker
          image: ghcr.io/opencode-bot-agent/opencode-bot-agent:latest
          command: ["bun", "run", "start:worker"]
          env:
            - name: REDIS_URL
              value: "redis://redis:6379"
            - name: OPENAI_API_KEY
              valueFrom:
                secretKeyRef:
                  name: llbot-secrets
                  key: OPENAI_API_KEY
          volumeMounts:
            - name: data
              mountPath: /data
      volumes:
        - name: data
          persistentVolumeClaim:
            claimName: bot-data
```

### 部署命令

```bash
kubectl apply -f deployments/k8s/bot-namespace.yaml
kubectl apply -f deployments/k8s/redis.yaml
kubectl apply -f deployments/k8s/llbot-pvc.yaml
kubectl apply -f deployments/k8s/llbot-secret.yaml
kubectl apply -f deployments/k8s/llbot-configmap.yaml
kubectl apply -f deployments/k8s/llbot-deployment.yaml
kubectl apply -f deployments/k8s/llbot-service.yaml
kubectl apply -f deployments/k8s/opencode-bot-agent-adapter.yaml
kubectl apply -f deployments/k8s/opencode-bot-agent-worker.yaml
kubectl apply -f deployments/k8s/session-cleaner-cronjob.yaml
```

如果你的节点是 ARM 架构，请使用 amd64 节点运行或自行构建对应架构镜像。

## QQ 登录

### 首次登录

LuckyLilliaBot 需要扫码登录。在 K8s 环境中：

```bash
# 查看日志获取二维码
kubectl logs -f deployment/luckylillia -n bot

# 或者端口转发，访问 WebUI
kubectl port-forward svc/luckylillia 3080:3080 -n bot
```

### Session 持久化

登录成功后，session 数据保存在 PVC 中。重启不需要重新登录。

## 监控

### 健康检查

当前版本已提供 HTTP 健康检查端点：

```bash
curl http://localhost:8080/health
```

### 日志

建议使用日志收集系统（如 Loki、ELK）收集和分析日志。

### 指标

Prometheus 指标端点仍在规划中（暂无 `/metrics` 路由）。

## 安全建议

1. **API Key 保护**：使用 K8s Secret 或外部密钥管理
2. **网络隔离**：LuckyLilliaBot 不需要对外暴露
3. **资源限制**：设置 Pod 资源限制防止 OOM
4. **日志脱敏**：确保日志中不包含敏感信息
