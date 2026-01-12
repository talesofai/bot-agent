# Bot Agent 开发规划

> 说明：TypeScript 实现已落地，以下为历史规划记录，状态可能与当前实现不一致。

## 项目概述

基于 AI Agent 的多平台聊天机器人系统，已支持 QQ 群，Discord 适配仍在规划中。

---

## 技术决策

| 决策项      | 选择                   | 理由                                                 |
| ----------- | ---------------------- | ---------------------------------------------------- |
| **语言**    | TypeScript             | 与 opencode/LuckyLilliaBot 一致，discord.js 生态成熟 |
| **QQ 协议** | LuckyLilliaBot + Milky | 协议稳定，不易封号                                   |
| **AI 调用** | opencode CLI           | 统一封装模型调用，支持 MCP                           |
| **多平台**  | Adapter 模式           | 统一接口，QQ/Discord 可扩展                          |

---

## 架构设计

```
┌────────────────────────────────────────────────────┐
│                    Bot Agent                        │
├────────────────────────────────────────────────────┤
│  ┌──────────────────────────────────────────────┐  │
│  │              Message Handler                  │  │
│  │         (统一消息处理逻辑)                    │  │
│  └──────────────────────────────────────────────┘  │
│                        │                           │
│  ┌─────────────────────┴─────────────────────┐    │
│  │            Platform Adapters               │    │
│  │  ┌─────────────┐    ┌─────────────────┐   │    │
│  │  │  QQ Adapter │    │ Discord Adapter │   │    │
│  │  │            │    │   (规划)        │   │    │
│  │  │  (Milky)    │    │ (discord.js, 规划) │   │    │
│  │  └─────────────┘    └─────────────────┘   │    │
│  └───────────────────────────────────────────┘    │
│                        │                           │
│  ┌──────────────────────────────────────────────┐  │
│  │              Agent (LLM 调用)                 │  │
│  │  opencode + MCP 工具                          │  │
│  └──────────────────────────────────────────────┘  │
│                        │                           │
│  ┌──────────────────────────────────────────────┐  │
│  │              Group Store (文件系统)           │  │
│  │  /data/groups/{id}/agent.md, skills/, ...    │  │
│  └──────────────────────────────────────────────┘  │
└────────────────────────────────────────────────────┘
```

---

## 核心接口定义

### PlatformAdapter 接口

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

### UnifiedMessage 统一消息格式

```typescript
interface UnifiedMessage {
  id: string;
  platform: string;
  channelId: string; // 群号 / 频道 ID
  channelType: "group" | "private";
  userId: string;
  sender: { nickname; displayName; role };
  content: string;
  mentionsBot: boolean;
  timestamp: number;
  raw: unknown; // 平台原始数据
}
```

---

## 开发任务拆分

### Phase 0: 环境验证（1-2 天）

> 目标：验证 LuckyLilliaBot 在 K8s 的可行性

| 任务                            | 负责人 | 状态 |
| ------------------------------- | ------ | ---- |
| 创建 LuckyLilliaBot Docker 镜像 |        | ⬜   |
| K8s Deployment 配置             |        | ⬜   |
| QQ 登录测试（观察 3-5 天）      |        | ⬜   |
| Milky WebSocket 连通性验证      |        | ⬜   |

---

### Phase 1: 项目基础（2-3 天）

> 目标：搭建 TypeScript 项目结构

| 任务                         | 负责人 | 状态 |
| ---------------------------- | ------ | ---- |
| 初始化 TypeScript 项目       |        | ⬜   |
| 配置 ESLint + Prettier       |        | ⬜   |
| 定义 PlatformAdapter 接口    |        | ⬜   |
| 定义 UnifiedMessage 类型     |        | ⬜   |
| 实现配置加载（dotenv + zod） |        | ⬜   |
| 实现 Logger 模块（pino）     |        | ⬜   |

---

### Phase 2: QQ 适配器（3-5 天）

> 目标：实现 QQ 平台消息收发

| 任务                 | 负责人 | 状态 |
| -------------------- | ------ | ---- |
| 实现 QQAdapter 类    |        | ⬜   |
| WebSocket 连接 Milky |        | ⬜   |
| 消息接收与解析       |        | ⬜   |
| 消息发送（文本）     |        | ⬜   |
| 消息发送（图片）     |        | ⬜   |
| 重连机制             |        | ⬜   |
| 单元测试             |        | ⬜   |

---

### Phase 3: 群存储（2-3 天）

> 目标：实现群配置和数据持久化

| 任务                   | 负责人 | 状态 |
| ---------------------- | ------ | ---- |
| GroupStore 类实现      |        | ⬜   |
| 群目录结构创建         |        | ⬜   |
| agent.md 加载          |        | ⬜   |
| skills/ 加载           |        | ⬜   |
| config.yaml 解析       |        | ⬜   |
| 配置热更新（chokidar） |        | ⬜   |

---

### Phase 4: Agent 集成（3-5 天）

> 目标：接入 LLM 进行消息处理

| 任务               | 负责人 | 状态 |
| ------------------ | ------ | ---- |
| Agent 接口定义     |        | ⬜   |
| opencode runner    |        | ⬜   |
| opencode 输出解析  |        | ⬜   |
| System Prompt 构建 |        | ⬜   |
| Skills 注入        |        | ⬜   |
| 响应解析与发送     |        | ⬜   |

---

### Phase 5: 消息处理器（2-3 天）

> 目标：统一消息处理逻辑

| 任务                                | 负责人 | 状态 |
| ----------------------------------- | ------ | ---- |
| MessageHandler 实现                 |        | ⬜   |
| 触发模式判断（mention/keyword/all） |        | ⬜   |
| 冷却机制                            |        | ⬜   |
| 管理员权限                          |        | ⬜   |
| 错误处理                            |        | ⬜   |

---

### Phase 6: HTTP API（2 天）

> 目标：提供管理接口

| 任务                           | 负责人 | 状态 |
| ------------------------------ | ------ | ---- |
| HTTP Server（Bun.serve）       |        | ⬜   |
| GET /health                    |        | ⬜   |
| GET /api/v1/groups             |        | ⬜   |
| PUT /api/v1/groups/:id         |        | ⬜   |
| POST /api/v1/groups/:id/reload |        | ⬜   |

---

### Phase 7: 部署配置（2 天）

> 目标：生产环境部署

| 任务                                  | 负责人 | 状态 |
| ------------------------------------- | ------ | ---- |
| Dockerfile                            |        | ⬜   |
| deployments/docker/docker-compose.yml |        | ⬜   |
| K8s Deployment                        |        | ⬜   |
| K8s Service                           |        | ⬜   |
| K8s PVC                               |        | ⬜   |
| CI/CD Pipeline                        |        | ⬜   |

---

### Phase 8: Discord 适配器（未来）

> 目标：支持 Discord 平台

| 任务                  | 负责人 | 状态 |
| --------------------- | ------ | ---- |
| DiscordAdapter 类实现 |        | ⬜   |
| discord.js 集成       |        | ⬜   |
| Slash Commands 支持   |        | ⬜   |
| 消息收发              |        | ⬜   |

---

## 依赖库

依赖版本以 `package.json` 为准（Bun 运行时）。关键依赖包括：

- `@saltify/milky-node-sdk`
- `bullmq`
- `ioredis`
- `opencode-ai`
- `pino`
- `yaml`
- `zod`
- `chokidar`
- `lru-cache`
- `openai`

---

## 群目录结构

```
/data/groups/{group_id}/
├── agent.md          # Agent 人设
├── config.yaml       # 群配置
├── skills/           # 技能
│   ├── draw.md
│   └── roleplay.md
├── sessions/         # 会话
│   └── {user}-{key}/
│       └── history.jsonl
└── assets/           # 资源
    └── images/
```

---

## 参考资料

- [LuckyLilliaBot](https://github.com/LLOneBot/LuckyLilliaBot)
- [Milky 协议](https://milky.ntqqrev.org/)
- [opencode](https://github.com/opencode-ai/opencode)
- [Eridanus (参考)](https://github.com/AOrbitron/Eridanus)
- [discord.js](https://discord.js.org/)
