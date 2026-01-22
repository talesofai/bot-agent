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
│   └── .env
└── data/
    ├── llbot/          # LuckyLilliaBot (LLBot) 数据
    ├── postgres/       # PostgreSQL 数据（历史与可变状态）
    ├── redis/          # Redis 数据（BullMQ Backend）
    ├── groups/         # 群数据（GROUPS_DATA_DIR；默认 /data/groups）
    ├── router/         # 全局关键词（DATA_DIR；默认 /data）
    └── bots/           # 机器人关键词（DATA_DIR；默认 /data）
```

### docker-compose.yml

使用 `deployments/docker/docker-compose.yml` 启动完整栈（Redis + PostgreSQL + LuckyLilliaBot + Adapter + Worker）。

- `DATABASE_URL` 必须可用（建议通过 `configs/.env` 或运行环境变量注入）
- `REDIS_URL` 必须可用（BullMQ 依赖）
- 数据库 Schema 不在运行时自动创建：Compose 的 Postgres 容器会在首次初始化时执行 `deployments/docker/postgres-init/*.sql`；使用外部/既有 Postgres 时需要手动执行同一迁移脚本
- Worker 依赖 opencode server：Compose 已包含 `opencode-server` 服务，Worker 通过 `OPENCODE_SERVER_URL=http://opencode-server:4096` 调用
- 为支持 opencode server 多副本/重启后继续使用同一会话，建议把 server 的 `HOME` 指到持久化卷（Compose 示例使用 `/data/opencode-home`）

### PMHQ 的 `privileged: true`（安全说明）

`pmhq` 镜像来自上游 PMHQ（Pure memory hook QQNT）。它通过 **ptrace/进程注入** 去 hook QQNT，这类行为在容器里会被 Docker/K8s 的默认安全策略直接拦掉（默认丢弃 `CAP_SYS_PTRACE`，并启用默认 seccomp profile）。

因此当前 Compose/K8s 清单将 `pmhq` 以 `privileged: true` 运行，属于“为了能跑先开大权限”的做法，安全与运维成本非常高。

最低要求的目标（待验证）：用 **最小权限** 替代 `privileged`，优先尝试：

- `cap_add: ["SYS_PTRACE"]`
- `security_opt: ["seccomp=unconfined"]`（部分发行版还需要 `apparmor=unconfined`）

在没有明确验证前，不要把 `pmhq` 与其他高价值工作负载混跑：建议专机/独立节点池、最小可访问网络、最小挂载目录，并严格限制宿主机权限与凭据暴露。

### 启动命令

```bash
cd /opt/opencode-bot-agent
docker compose -f deployments/docker/docker-compose.yml up -d
```

### 升级

如仅更新 Bot Agent（Adapter/Worker/opencode-server）：

```bash
cd /opt/opencode-bot-agent
docker compose -f deployments/docker/docker-compose.yml pull opencode-bot-agent-adapter opencode-bot-agent-worker opencode-server
docker compose -f deployments/docker/docker-compose.yml up -d --force-recreate opencode-bot-agent-adapter opencode-bot-agent-worker opencode-server
```

## Kubernetes 部署（仍在迭代）

当前仓库已提供 `deployments/k8s/` 目录，采用 `llbot` StatefulSet（单 Pod 内含 `luckylillia` + `pmhq` 两个容器）：

- `deployments/k8s/bot-namespace.yaml`
- `deployments/k8s/bot-data-pvc.yaml`（Bot Agent /data 持久化）
- `deployments/k8s/llbot-configmap.yaml`
- `deployments/k8s/llbot-services.yaml`（headless + 单 Pod WebUI Service）
- `deployments/k8s/llbot-statefulset.yaml`
- `deployments/k8s/llbot-ingress.yaml`（可选）
- `deployments/k8s/redis.yaml`
- `deployments/k8s/postgres.yaml`
- `deployments/k8s/opencode-bot-agent-adapter.yaml`
- `deployments/k8s/opencode-bot-agent-worker.yaml`
- `deployments/k8s/session-cleaner-cronjob.yaml`

## Secret 管理（推荐）

本仓库为 public，任何 secret 都不应提交。统一使用 `configs/.env` 与 `deployments/k8s/llbot-secret.yaml`：

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
  OPENAI_BASE_URL: ""
  OPENAI_API_KEY: ""
  OPENCODE_MODELS: ""
  OPENCODE_YOLO: "true" # 可选：默认 true；设为 false 可降低 opencode agent 权限
  POSTGRES_PASSWORD: ""
  DATABASE_URL: ""
  API_TOKEN: "" # Bot Agent HTTP 管理端点鉴权
```

### PersistentVolumeClaim

```yaml
# deployments/k8s/bot-data-pvc.yaml
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: bot-data
  namespace: bot
spec:
  storageClassName: alibabacloud-cnfs-nas
  accessModes:
    - ReadWriteMany
  resources:
    requests:
      storage: 100Gi
```

### LLBot StatefulSet

LLBot 仅负责 QQ 客户端与 WebUI。主服务通过 Redis 注册表发现 llbot，并建立 WS 连接；每个 llbot Pod 内需要运行注册器定期写入 `llbot:registry:{botId}`。为了允许主服务直连，`onlyLocalhost` 必须关闭。

注册器可直接运行本仓库脚本（示例）：

```bash
LLBOT_REGISTRY_BOT_ID=123 \
LLBOT_REGISTRY_WS_URL=ws://llbot-0.llbot-0-headless:3000 \
LLBOT_REGISTRY_TTL_SEC=30 \
LLBOT_REGISTRY_REFRESH_SEC=10 \
bun run llbot:registrar
```

LLBot 的 Kubernetes 资源见：

- `deployments/k8s/llbot-statefulset.yaml`
- `deployments/k8s/llbot-services.yaml`
- `deployments/k8s/llbot-ingress.yaml`（可选）

### Bot Agent Deployment

Adapter 与 Worker 分离部署，入口命令分别为 `start:adapter` / `start:worker`。
无需配置 `PLATFORM`；默认启用 QQ，提供 `DISCORD_TOKEN` 时会同时启用 Discord。

此外需要部署独立的 opencode server（HTTP），供 Worker 调用：

- 建议独立 Deployment + Service（例如 `opencode-server:4096`）
- **必须挂载同一份 RWX `/data`**，并设置 `HOME=/data/opencode-home` 让 opencode 的 `~/.local/share/opencode` 会话存储在共享卷上
- 可选：设置 `OPENCODE_SERVER_PASSWORD` 启用 Basic Auth，并同步配置 Worker 的 `OPENCODE_SERVER_USERNAME/OPENCODE_SERVER_PASSWORD`
- 若需要 Web UI 查看 sessions：确保 server 启动参数允许 `https://app.opencode.ai` 的 CORS（本仓库示例已加），然后通过 Ingress 或 `kubectl port-forward svc/opencode-server 4096:4096` 暴露端口

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
          image: opencode-bot-agent:latest
          command: ["bun", "run", "start:adapter"]
          env:
            - name: REDIS_URL
              value: "redis://redis:6379"
            - name: LLBOT_REGISTRY_PREFIX
              value: "llbot:registry"
            - name: DISCORD_TOKEN
              valueFrom:
                secretKeyRef:
                  name: llbot-secrets
                  key: DISCORD_TOKEN
                  optional: true
            - name: DISCORD_APPLICATION_ID
              valueFrom:
                secretKeyRef:
                  name: llbot-secrets
                  key: DISCORD_APPLICATION_ID
                  optional: true
            - name: OPENCODE_MODELS
              valueFrom:
                secretKeyRef:
                  name: llbot-secrets
                  key: OPENCODE_MODELS
                  optional: true
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
          image: opencode-bot-agent:latest
          command: ["bun", "run", "start:worker"]
          env:
            - name: REDIS_URL
              value: "redis://redis:6379"
            - name: DATABASE_URL
              valueFrom:
                secretKeyRef:
                  name: llbot-secrets
                  key: DATABASE_URL
            - name: OPENAI_API_KEY
              valueFrom:
                secretKeyRef:
                  name: llbot-secrets
                  key: OPENAI_API_KEY
                  optional: true
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
kubectl apply -f deployments/k8s/postgres.yaml
kubectl apply -f deployments/k8s/bot-data-pvc.yaml
kubectl apply -f deployments/k8s/llbot-secret.yaml
kubectl apply -f deployments/k8s/llbot-configmap.yaml
kubectl apply -f deployments/k8s/llbot-services.yaml
kubectl apply -f deployments/k8s/llbot-statefulset.yaml
kubectl apply -f deployments/k8s/opencode-bot-agent-adapter.yaml
kubectl apply -f deployments/k8s/opencode-bot-agent-worker.yaml
kubectl apply -f deployments/k8s/session-cleaner-cronjob.yaml

# 将 Bot Agent 镜像切换到阿里云镜像仓库（示例为 latest tag）
kubectl -n bot set image deployment/opencode-bot-agent-adapter opencode-bot-agent-adapter=registry.cn-shanghai.aliyuncs.com/talesofai/opencode-bot-agent:latest
kubectl -n bot set image deployment/opencode-bot-agent-worker opencode-bot-agent-worker=registry.cn-shanghai.aliyuncs.com/talesofai/opencode-bot-agent:latest
kubectl -n bot set image cronjob/session-cleaner session-cleaner=registry.cn-shanghai.aliyuncs.com/talesofai/opencode-bot-agent:latest

# 若集群无法访问 docker.io，可将基础依赖也切到镜像仓库
kubectl -n bot set image statefulset/redis redis=registry.cn-shanghai.aliyuncs.com/talesofai/redis:7.4-alpine
kubectl -n bot set image statefulset/postgres postgres=registry.cn-shanghai.aliyuncs.com/talesofai/postgres:16-alpine
```

### 升级（更新镜像）

使用 `latest` tag 时，请确保相关 Deployment/CronJob 设置了 `imagePullPolicy: Always`，然后重启工作负载让节点拉取新镜像：

```bash
kubectl -n bot rollout restart deployment/opencode-bot-agent-adapter
kubectl -n bot rollout restart deployment/opencode-bot-agent-worker
kubectl -n bot rollout restart deployment/opencode-server

kubectl -n bot rollout status deployment/opencode-bot-agent-adapter
kubectl -n bot rollout status deployment/opencode-bot-agent-worker
kubectl -n bot rollout status deployment/opencode-server
```

CronJob 会在下次触发时拉取新镜像；如需立刻执行一次清理，可手动触发一个 Job：

```bash
kubectl -n bot create job --from=cronjob/session-cleaner session-cleaner-manual-$(date +%s)
```

如果你的节点是 ARM 架构，请使用 amd64 节点运行或自行构建对应架构镜像。

## QQ 登录

### 首次登录

LuckyLilliaBot 需要扫码登录。在 K8s 环境中：

```bash
# 查看日志获取二维码
kubectl logs -f pod/llbot-0 -c luckylillia -n bot

# 或者端口转发，访问 WebUI
kubectl port-forward svc/llbot-0 3080:3080 -n bot
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
