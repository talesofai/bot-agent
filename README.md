# opencode-bot-agent

基于 AI Agent 的 QQ 群机器人系统，使用 opencode 作为核心 Agent，支持自定义群配置和技能扩展。

## 当前状态

仓库已包含 TypeScript 实现与部署配置。开发细节见 `docs/development-plan.md` 与 `docs/development.md`。

## ✨ 特性

- 🤖 **AI Agent 驱动**：使用 opencode 作为核心 Agent，支持 MCP 协议扩展
- 📁 **群隔离架构**：每个群独立配置目录，支持自定义 Agent 人设和技能
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

```
opencode-bot-agent/
├── src/                   # TypeScript 源码（含测试）
├── configs/               # 配置文件
├── deployments/           # 部署配置
│   ├── docker/           # Docker 相关
│   └── k8s/              # Kubernetes 相关
├── docs/                  # 文档
└── data/                  # 运行时数据（群目录）
    └── groups/
        └── {group_id}/
            ├── agent.md  # 群 Agent 配置（覆盖默认设计）
            └── skills/   # 群技能（同名覆盖默认技能，新增为扩展）
```

默认 Agent 设计来自 `configs/default-agent.md`。通用技能（规划）与群内 `skills/` 合并加载，同名覆盖，新增补充。

## 🧩 部署目录

Kubernetes 资源统一放在 `deployments/k8s/`，并使用统一前缀 `llbot-*.yaml`。
Docker Compose 文件位于 `deployments/docker/docker-compose.yml`。

## 📝 License

MIT License
