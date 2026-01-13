# 开发指南

本文档面向开发者，介绍如何参与 Bot Agent 开发（以 TypeScript 为主）。

## 开发环境

### 前置要求

- **Bun** (v1.0+) - 唯一运行时和包管理器，不使用 npm/pnpm/yarn
- Docker 与 Docker Compose

### 克隆项目

```bash
git clone https://github.com/talesofai/opencode-bot-agent.git
cd opencode-bot-agent
```

### 提交评审（opencode PR agent）

本仓库使用 OpenCode GitHub Actions 在 PR 每次提交（`synchronize`）时触发评审，并支持在 PR/Issue 评论中触发复审或对话，配置见 `.github/workflows/opencode-review.yml` 与 `.github/workflows/opencode.yml`。

需要在仓库 Secrets 中配置：

- `OPENAI_API_KEY`（必填）：OpenAI API Key。
- `OPENAI_BASE_URL`（可选）：自定义 OpenAI API Base（如代理或兼容服务）。

工作流使用 `GITHUB_TOKEN` 更新 PR 描述并发布评审意见，请确保 `pull-requests: write` 权限开启。
首次使用前请安装 OpenCode GitHub App（https://github.com/apps/opencode-agent）。

PR 评论触发示例：

- `/opencode review`
- `/opencode describe`（更新 PR 描述）
- `/opencode 重新评审并关注测试覆盖`
- `/opencode fix this`（在 Issue 或 PR 中提出修复需求）

对话会结合 PR 标题、描述、提交记录与评论上下文。

## 本地运行（推荐）

使用 Docker Compose 启动 LuckyLilliaBot：

```bash
cp configs/example.env configs/.env
export CONFIG_PATH=configs/.env
./scripts/init-secrets.sh
docker compose -f deployments/docker/docker-compose.yml up -d
```

查看日志：

```bash
docker compose -f deployments/docker/docker-compose.yml logs -f luckylillia
```

## 项目结构

```
opencode-bot-agent/
├── src/                   # TypeScript 源码（含测试）
├── configs/               # 配置文件
├── deployments/           # 部署配置
├── docs/                  # 文档
└── data/                  # 运行时数据（群目录）
    └── groups/{group_id}/
```

## 代码规范

- TypeScript 代码遵循 ESLint + Prettier：`bun run lint`、`bun run format`。
- 命名约定：变量/函数使用 `camelCase`，类型/类使用 `PascalCase`。
- 配置文件使用 YAML/Markdown，保持 `configs/` 现有命名风格。

## 核心模块

多平台适配采用 Adapter 模式，接口示例：

```typescript
interface PlatformAdapter {
  platform: string; // 'qq' | 'discord'
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  onMessage(handler: MessageHandler): void;
  onConnect(handler: ConnectionHandler): void;
  onDisconnect(handler: ConnectionHandler): void;
  sendMessage(options: SendMessageOptions): Promise<void>;
  getBotUserId(): string | null;
}
```

统一消息结构：

```typescript
interface UnifiedMessage {
  id: string;
  platform: string;
  channelId: string;
  channelType: "group" | "private";
  userId: string;
  sender: { nickname: string; displayName: string; role: string };
  content: string;
  mentionsBot: boolean;
  timestamp: number;
  raw: unknown;
}
```

## 测试

- 运行测试：`bun test src`
- 新增功能需配套测试与日志校验。
- 集成测试（真实 opencode）：`OPENCODE_INTEGRATION=1 OPENCODE_MODEL=glm-4.7 bun test src`
- 如需指定二进制路径，可额外设置 `OPENCODE_BIN=/path/to/opencode`。
- Redis 集成测试（Response Worker）：`REDIS_INTEGRATION=1 REDIS_URL=redis://localhost:6379 bun test src`
