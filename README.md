# opencode-bot-agent

基于 AI Agent 的 QQ 群机器人系统，使用 opencode 作为核心 Agent，支持自定义群配置与目录化技能（SKILL.md + scripts）。

## 当前状态

仓库已包含 TypeScript 实现与部署配置。开发细节见 `docs/development-plan.md` 与 `docs/development.md`。

## ✨ 特性

- 🤖 **AI Agent 驱动**：使用 opencode 作为核心 Agent，支持 MCP 协议扩展
- 📁 **群隔离架构**：每个群独立配置目录，支持自定义 Agent 人设与目录化技能覆盖
- 🔌 **可扩展**：通过 talesofai MCP 扩展能力，支持捏 Ta 等核心玩法
- 🐧 **Linux 原生**：支持 Docker/K8s 容器化部署
- 🌐 **多平台规划**：未来支持 Discord 等海外平台

## 📖 文档

| 文档                                        | 说明               |
| ------------------------------------------- | ------------------ |
| [架构设计](docs/architecture.md)            | 系统架构和技术选型 |
| [快速开始](docs/getting-started.md)         | 5 分钟部署体验     |
| [部署指南](docs/deployment.md)              | 生产环境部署       |
| [配置说明](docs/configuration.md)           | 配置项详解         |
| [开发指南](docs/development.md)             | 开发者文档         |
| [API 参考](docs/api-reference.md)           | API 接口文档       |
| [Agent 自定义](docs/agent-customization.md) | 群 Agent 配置指南  |
| [Secret 管理](docs/secrets.md)              | 机密管理与规范     |

## 🏗️ 技术栈

| 层级     | 技术                                                                                                |
| -------- | --------------------------------------------------------------------------------------------------- |
| QQ 协议  | [LuckyLilliaBot](https://github.com/LLOneBot/LuckyLilliaBot) + [Milky](https://milky.ntqqrev.org/)  |
| 消息处理 | TypeScript (Bun) + [@saltify/milky-node-sdk](https://www.npmjs.com/package/@saltify/milky-node-sdk) |
| AI Agent | [opencode](https://github.com/opencode-ai/opencode)                                                 |
| 扩展     | talesofai MCP Server                                                                                |
| 部署     | Docker + Kubernetes                                                                                 |

## 🚀 快速开始

详见 [快速开始文档](docs/getting-started.md)。

**注意**：本项目仅使用 [Bun](https://bun.sh) 作为运行时和包管理器，不支持 npm/pnpm/yarn。

## 📁 项目结构

````
	opencode-bot-agent/
	├── src/                   # TypeScript 源码（含测试）
	├── configs/               # 配置文件
	├── deployments/           # 部署配置
	│   ├── docker/           # Docker 相关
	│   └── k8s/              # Kubernetes 相关
	├── docs/                  # 文档
	└── data/                  # 运行时数据（容器内默认挂载到 /data）
	    ├── groups/            # GROUPS_DATA_DIR（默认 /data/groups）
	    │   ├── {group_id}/
	    │   │   ├── agent.md   # 群 Agent 人设（覆盖默认）
	    │   │   ├── config.yaml # 群配置
	    │   │   ├── skills/    # 群技能（{skillName}/SKILL.md + scripts/*）
	    │   │   └── assets/    # 群资源
	    │   │       └── images/
	    │   └── sessions/      # 会话目录（每个用户/会话一个目录）
	    │       └── {botId}/{groupId}/{userId}/
	    │           ├── index.json  # 会话槽位 -> 当前 sessionId 映射
	    │           └── {sessionId}/
	    │               ├── meta.json
	    │               └── workspace/
	    │                   ├── input/
	    │                   └── output/
	    ├── router/            # DATA_DIR（默认 /data）
	    │   └── global.yaml
	    ├── bots/
	    │   └── {botId}/
	    │       ├── config.yaml
	    │       └── skills/    # 可选：机器人级 opencode skills 覆盖
	    ├── global/
	    │   └── skills/        # 可选：全局 opencode skills 覆盖
	    ├── llbot/             # Docker Compose：LuckyLilliaBot 数据
	    ├── postgres/          # Docker Compose：PostgreSQL 数据
	    └── redis/             # Docker Compose：Redis 数据
```

默认 Agent 设计来自 `configs/default-agent.md`。Opencode skills 采用分层覆盖并在会话启动前同步：`configs/skills/` -> `/data/global/skills/` -> `/data/groups/{group_id}/skills/` -> `/data/bots/{botId}/skills/`。

## 🗃️ 历史与记录存放位置

- **对话历史（用于上下文）**：写入 Postgres `history_entries` 表（由 `DATABASE_URL` 指定；Schema 通过 `deployments/docker/postgres-init/001-history-entries.sql` 迁移创建/升级）。
- **会话运行记录（文件）**：位于 `${GROUPS_DATA_DIR}/sessions/{botId}/{groupId}/{userId}/{sessionId}`，包含 `meta.json` 与 `workspace/` 目录。
- **运行日志**：默认输出到 stdout/stderr（Docker 用 `docker compose logs -f ...`，K8s 用 `kubectl logs ...` 查看），不写入 `data/`。

## 🧩 部署目录

Kubernetes 资源统一放在 `deployments/k8s/`，并使用统一前缀 `llbot-*.yaml`。
Docker Compose 文件位于 `deployments/docker/docker-compose.yml`。

## 📝 License

MIT License
````
