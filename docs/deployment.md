# 部署指南

本文档介绍生产环境部署方案。当前 Bot Agent 代码实现尚未落地，以下内容以部署规划与示例配置为主。

## 部署方式

| 方式           | 适用场景         | 复杂度 |
| -------------- | ---------------- | ------ |
| Docker Compose | 单机、开发测试   | ⭐     |
| Kubernetes     | 生产环境、多实例 | ⭐⭐⭐ |

当前仅 LuckyLilliaBot 可稳定部署，Bot Agent 相关部分为规划配置。

## Docker Compose 部署（规划）

### 目录结构

```
/opt/opencode-bot-agent/
├── deployments/
│   └── docker/
│       └── docker-compose.yml
├── configs/
│   └── .env
└── data/
    ├── llbot/          # LuckyLilliaBot (LLBot) 数据
    └── groups/         # 群数据
```

### docker-compose.yml

当前仅启用 LuckyLilliaBot（LLBot Docker 版），Bot Agent 以注释方式保留占位。

```yaml
version: "3.8"

services:
  pmhq:
    image: linyuchen/pmhq:latest
    container_name: luckylillia-pmhq
    restart: unless-stopped
    privileged: true
    environment:
      - ENABLE_HEADLESS=false
      - AUTO_LOGIN_QQ=
    volumes:
      - ./data/llbot/qq:/root/.config/QQ
      - ./data/llbot/data:/app/llbot/data

  luckylillia:
    image: linyuchen/llbot:latest
    container_name: luckylillia
    restart: unless-stopped
    env_file:
      - ./configs/.env
      - ./configs/secrets/.env
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
      - ./data/llbot/data:/app/llbot/data
      - ./data/llbot/qq:/root/.config/QQ
      - ./data/llbot/default_config.json:/config/default_config.json:ro
      - ./scripts/llbot-entrypoint.sh:/config/llbot-entrypoint.sh:ro
    depends_on:
      - pmhq

  # opencode-bot-agent:
  #   image: ghcr.io/talesofai/opencode-bot-agent:latest # 规划中的镜像
  #   container_name: opencode-bot-agent
  #   restart: unless-stopped
  #   depends_on:
  #     - luckylillia
  #   volumes:
  #     - ./data/groups:/data/groups
  #     - ./configs:/app/configs
  #   env_file:
  #     - ./configs/.env
  #   environment:
  #     - MILKY_URL=http://luckylillia:3000
```

当前使用公开镜像 `linyuchen/pmhq` 与 `linyuchen/llbot`，如需固定版本可在 compose 中替换 tag。

### 启动命令

```bash
cd /opt/opencode-bot-agent
docker compose -f deployments/docker/docker-compose.yml up -d
```

## Kubernetes 部署（规划）

当前仓库已提供 `deployments/k8s/` 目录，可直接应用基础资源：

- `deployments/k8s/llbot-namespace.yaml`
- `deployments/k8s/llbot-pvc.yaml`
- `deployments/k8s/llbot-configmap.yaml`
- `deployments/k8s/pmhq-deployment.yaml`
- `deployments/k8s/llbot-deployment.yaml`
- `deployments/k8s/llbot-service.yaml`

## Secret 管理（推荐）

本仓库为 public，任何 secret 都不应提交。统一使用 `configs/secrets/.env` 与 `deployments/k8s/llbot-secret.yaml`：

### Docker / 本地

```bash
./scripts/init-secrets.sh
```

设置 `WEBUI_TOKEN` 等敏感项后，直接启动：

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
# deployments/k8s/llbot-namespace.yaml
apiVersion: v1
kind: Namespace
metadata:
  name: opencode-bot-agent
```

### Secret（API Keys）

```yaml
# deployments/k8s/llbot-secret.yaml（由 scripts/generate-k8s-secret.sh 生成）
apiVersion: v1
kind: Secret
metadata:
  name: llbot-secrets
  namespace: opencode-bot-agent
type: Opaque
stringData:
  WEBUI_TOKEN: "change-me"
  OPENAI_API_KEY: ""
  ANTHROPIC_API_KEY: ""
  GEMINI_API_KEY: ""
  API_TOKEN: ""
```

### PersistentVolumeClaim

```yaml
# deployments/k8s/llbot-pvc.yaml
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: opencode-bot-agent-data
  namespace: opencode-bot-agent
spec:
  accessModes:
    - ReadWriteOnce
  resources:
    requests:
      storage: 10Gi
```

### LLBot Deployment

```yaml
# deployments/k8s/llbot-deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: luckylillia
  namespace: opencode-bot-agent
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

```yaml
# deployments/k8s/opencode-bot-agent.yaml（示例，需自行创建）
apiVersion: apps/v1
kind: Deployment
metadata:
  name: opencode-bot-agent
  namespace: opencode-bot-agent
spec:
  replicas: 1
  selector:
    matchLabels:
      app: opencode-bot-agent
  template:
    metadata:
      labels:
        app: opencode-bot-agent
    spec:
      containers:
        - name: opencode-bot-agent
          image: ghcr.io/talesofai/opencode-bot-agent:latest
          env:
            - name: MILKY_URL
              value: "http://luckylillia:3000"
            - name: OPENAI_API_KEY
              valueFrom:
                secretKeyRef:
                  name: opencode-bot-agent-secrets
                  key: OPENAI_API_KEY
          volumeMounts:
            - name: data
              mountPath: /data/groups
              subPath: groups
      volumes:
        - name: data
          persistentVolumeClaim:
            claimName: opencode-bot-agent-data
```

### 部署命令

```bash
kubectl apply -f deployments/k8s/llbot-namespace.yaml
kubectl apply -f deployments/k8s/llbot-pvc.yaml
kubectl apply -f deployments/k8s/llbot-secret.yaml
kubectl apply -f deployments/k8s/llbot-configmap.yaml
kubectl apply -f deployments/k8s/pmhq-deployment.yaml
kubectl apply -f deployments/k8s/llbot-deployment.yaml
kubectl apply -f deployments/k8s/llbot-service.yaml
```

如果你的节点是 ARM 架构，请使用 amd64 节点运行或自行构建对应架构镜像。

## QQ 登录

### 首次登录

LuckyLilliaBot 需要扫码登录。在 K8s 环境中：

```bash
# 查看日志获取二维码
kubectl logs -f deployment/luckylillia -n opencode-bot-agent

# 或者端口转发，访问 WebUI
kubectl port-forward svc/luckylillia 3080:3080 -n opencode-bot-agent
```

### Session 持久化

登录成功后，session 数据保存在 PVC 中。重启不需要重新登录。

## 监控

### 健康检查

Bot Agent 提供健康检查端点：

```bash
curl http://localhost:8080/health
```

### 日志

建议使用日志收集系统（如 Loki、ELK）收集和分析日志。

### 指标

Bot Agent 暴露 Prometheus 指标：

```bash
curl http://localhost:8080/metrics
```

## 安全建议

1. **API Key 保护**：使用 K8s Secret 或外部密钥管理
2. **网络隔离**：LuckyLilliaBot 不需要对外暴露
3. **资源限制**：设置 Pod 资源限制防止 OOM
4. **日志脱敏**：确保日志中不包含敏感信息
