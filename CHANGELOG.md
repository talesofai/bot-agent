# Changelog

本项目的所有重要变更都会记录在这个文件中。

格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.0.0/)，
版本号遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。

## [Unreleased]

## [0.0.4] - 2026-01-12

### Added

- 群存储模块（`src/store/group.ts`）
  - GroupStore 类：群配置和数据持久化管理
  - 群目录自动创建与结构管理
  - config.yaml 配置加载（zod schema 验证）
  - agent.md 人设加载（支持 frontmatter）
  - skills/ 技能目录加载
  - chokidar 热更新监听（防抖处理）
- 群类型定义（`src/types/group.ts`）
  - GroupConfig、GroupData、Skill 接口
  - Zod schema 验证
- 群存储单元测试（`src/store/__tests__/group.test.ts`）
  - 12 个测试用例

## [0.0.3] - 2026-01-12

### Added

- QQ 平台适配器（`src/adapters/qq/`）
  - `adapter.ts`: 实现 `PlatformAdapter` 接口
  - `connection.ts`: Milky WebSocket 连接管理，支持断线重连与指数退避
  - `parser.ts`: Milky 事件解析为 `UnifiedMessage` 格式
  - `sender.ts`: 文本与图片消息发送
- QQ 适配器单元测试（`src/adapters/qq/__tests__/`）
  - `parser.test.ts`: 消息解析测试
  - `connection.test.ts`: 连接管理测试
- 优雅关闭处理（SIGINT/SIGTERM）

### Changed

- 更新 `src/index.ts` 集成 QQ 适配器并注册消息处理器

## [0.0.2] - 2026-01-12

### Added

- 配置加载模块（`src/config.ts`）
- 基础日志模块（`src/logger.ts`）
- 核心接口类型（`src/types/platform.ts`）
- ESLint 配置（`eslint.config.js`）与 TypeScript ESLint 依赖

## [0.0.1] - 2026-01-12

### Added

- 初始项目结构与 Bun/TypeScript 脚手架
- 占位入口 `src/index.ts` 与基础脚本配置
- 配置模板（`configs/config.yaml`、`configs/default-agent.md`、`configs/example.env`）
- Claude Code 时间查询技能（`.claude/skills/time-lookup/SKILL.md`）
- Claude Code 技能生成与优化技能（`.claude/skills/skill-authoring/SKILL.md`）
- 技能模板与校验脚本（`.claude/skills/skill-authoring/assets/skill-template/SKILL.md`、`.claude/skills/skill-authoring/scripts/validate_skill.sh`）
- Secret 初始化与轮换脚本
- LuckyLilliaBot/Milky 的 Docker Compose 与 K8s 部署资源
- 完整文档体系（架构、部署、配置、开发计划等）
