# 仓库指南

## 项目结构与模块组织

本仓库目前主要包含配置、部署资源和文档。TypeScript 实现已在规划中（详见 `docs/development-plan.md`）。关键路径如下：

- `configs/` — 配置模板，如 `configs/config.yaml` 和 `configs/default-agent.md`。
- `deployments/` — Docker/K8s 部署资源（包括 `deployments/docker/Dockerfile`）。
- `docs/` — 架构、开发和运维指南。
- `data/groups/{group_id}/` — 运行时群组数据（Agent 提示词、技能、上下文、资源）。

添加 TypeScript 源码时，请保持清晰的顶层布局（例如 `src/`、`test/`），并在此处记录结构。

## 构建、测试与开发命令

- `cp configs/example.env configs/.env` — 创建本地环境变量文件。
- `docker-compose up -d luckylillia` — 启动 LuckyLilliaBot（Bot Agent 实现落地后再启用完整栈）。
- `docker-compose logs -f` — 实时查看所有服务日志。
- `docker-compose logs -f opencode-bot-agent` — 仅实时查看 Bot Agent 日志。
- `docker-compose logs -f luckylillia` — 仅实时查看 LuckyLilliaBot 日志。

一旦 TypeScript 应用就绪，请在此处添加具体的 `bun run` 脚本。

## 代码风格与命名约定

- 已选定 TypeScript 作为开发语言（详见 `docs/adr/001-language-selection.md`）。
- 使用一致的命名规范：配置文件使用 `kebab-case`，变量使用 `camelCase`，类型/类使用 `PascalCase`。
- 保持配置和 Agent 提示词为 YAML/Markdown 格式；参照 `configs/` 中的现有命名。
- 引入 TS 工具链后，统一使用 ESLint + Prettier 并在此处记录相关命令。

## 测试指南

- 在规划的 TypeScript 模块旁添加测试（例如 `test/`）。
- 倾向于使用能描述行为的清晰测试名称。
- 添加工具链后，在此处记录测试运行器和覆盖率预期。

## 提交与 Pull Request 指南

- 使用 Conventional Commits（例如 `feat: ...`、`fix: ...`、`docs: ...`、`refactor: ...`）。
- PR 应包含简要总结、运行的测试命令以及任何配置/部署变更。
- 适用时链接相关 issue；仅在引入 UI/UX 变更时包含截图。

## 配置与安全提示

- 从 `configs/example.env` 开始，并将机密信息保存在环境变量中。
- `GROUPS_DATA_DIR` 必须指向持久化路径（例如容器中的 `/data/groups`）。
- 避免提交 API 密钥；如果意外泄露，请轮换凭据。
