# Changelog

本项目的所有重要变更都会记录在这个文件中。

格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.0.0/)，
版本号遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。

## [Unreleased]

## [0.0.17] - 2026-01-13

### Fixed

- SessionHistory 追加逻辑避免重复 user 记录
- 当 history 无 assistant 记录时追加输出内容
- Session key 校验负数输入
- SessionWorker 重试延迟使用配置值
- GroupWatcher 忽略 sessions 目录变更，避免无意义重载

### Changed

- SessionRepository 移除未使用的路径字段
- Opencode 启动参数结构精简
- 开发文档中的测试命令更新为 `bun test src`
- Opencode 启动时追加 `OPENCODE_MODEL`
- GroupStore 初始化失败时记录错误日志
- 仅在 adapter 角色初始化 GroupStore
- 读取 agent prompt 前修复群目录缺失文件

## [0.0.16] - 2026-01-13

### Added

- prompt 组装与 SessionManager 的单元测试

### Changed

- SessionManager 支持注入 activity tracker 以便测试

## [0.0.15] - 2026-01-13

### Added

- Opencode 输出解析与触发逻辑的单元测试

### Changed

- `bun test` 限定为 `bun test src`，避免示例目录干扰
- QQ 连接重连测试延长等待时间，降低不稳定性

## [0.0.14] - 2026-01-13

### Added

- system_prompt 追加 MCP usage method，用于 opencode system 指令

### Changed

- Opencode prompt 组装 system + history + 用户输入作为上下文

## [0.0.13] - 2026-01-13

### Added

- 群级触发逻辑（triggerMode/keywords/cooldown/adminUsers）
- 入口默认群 ID 支持（DEFAULT_GROUP_ID）

## [0.0.12] - 2026-01-13

### Added

- ShellOpencodeRunner 解析 JSON 输出并返回历史与响应内容

### Changed

- Opencode 启动参数统一为 `-p -c -f json`

## [0.0.11] - 2026-01-13

### Added

- Session 活跃索引（Redis ZSET）用于 TTL 清理

### Changed

- SessionWorker 使用简单的 Redis SetNX + TTL，移除心跳与锁续期状态机
- QQ 解析流程先标准化为 Segment 数组再提取文本
- HistoryStore 使用 `tail` 读取末尾记录，避免全量加载
- Adapter 工厂移除重复配置校验
- /health 版本号优先从环境变量读取并缓存
- QQ echo 改为简单递增计数

## [0.0.10] - 2026-01-13

### Added

- ShellOpencodeRunner 使用 `opencode` CLI 执行推理
- 新增响应队列与 ResponseWorker，用于发送 AI 回复
- 新增 `/health` 端点与 HTTP 服务配置

### Changed

- /health 使用 Bun.serve 实现，移除 Fastify 依赖
- Adapter 侧支持 `#<key>` 前缀解析会话 key

## [0.0.9] - 2026-01-13

### Fixed

- Worker 心跳续期连续失败时中止当前任务，避免锁丢失导致并发执行
- BullMQ stalled 处理参数可配置，降低卡死任务风险
- HistoryStore 读取尾部时保留完整首行，避免边界丢数据
- QQ echo 计数器接近上限时回绕，避免无界增长
- Worker 在锁丢失时发出中止信号，允许 Runner 提前退出

### Changed

- 配置加载改为惰性初始化，支持测试时重置配置
- 日志不再记录用户原文内容，改为记录摘要哈希与长度
- QQ 连接测试改用 mock-socket，减少自制 FakeWebSocket 偏差
- UnifiedMessage 支持泛型 raw 类型，减少 unknown 漫延
- Dockerfile 运行命令改为使用 `bun run start`
- Logger 改为惰性初始化，避免导入即加载配置

## [0.0.8] - 2026-01-13

### Added

- 分布式 Opencode 会话运行时：Session/Queue/Worker 组件与 Redis 锁
- 引入 BullMQ 队列与 Worker Pool，用于会话任务调度与并发处理
- 新增 Redis 依赖与 Docker Compose 服务
- 新增 `REDIS_URL`/`SERVICE_ROLE` 环境变量以支持队列与分角色部署
- 会话历史写入与 TTL 清理支持
- 分布式 Opencode 架构设计与 0.0.8 落地计划文档

### Changed

- 使用 `maxSessions` 取代 `allowMultipleSessions`，统一按 key 范围校验
- 入口改为按角色运行：adapter 入队消息，worker 消费会话任务
- QQAdapter 改为 EventEmitter 统一事件分发
- SessionRepository 封装路径细节，SessionInfo 精简为必要路径
- HistoryStore 读取历史时改为尾部读取，避免全量读入内存
- GroupStore 引入 LRU 缓存，限制群组数据常驻内存
- SessionTtlCleaner 扁平化遍历逻辑，避免深层嵌套
- 更新配置与部署文档以匹配用户独占会话模型

### Dependencies

- 新增 `bullmq` 与 `ioredis` 依赖以支持队列与锁
- 新增 `lru-cache` 用于 GroupStore 缓存

## [0.0.7] - 2026-01-12

### Changed

- GroupStore 拆分 Repository/Watcher，改为异步并行加载并支持懒加载
- 配置加载流程简化并支持 `CONFIG_PATH`
- Docker 基础镜像切换为 Bun 以匹配运行时选择

### Fixed

- QQ 连接重连流程扁平化并清理重复定时器与请求超时
- QQ 发送保持 `channelId` 为字符串，避免精度丢失
- 配置启动期强制校验平台依赖字段
- GroupStore 文件变更监听恢复防抖，减少重复加载

### Removed

- 移除 Discord 适配器死代码与未使用的 `ws` 依赖

### Performance

- 缓存 CQ 正则，优化消息解析热路径

## [0.0.6] - 2026-01-12

### Fixed

- 修复重连定时器重复调度问题，防止并发重连导致多个 WebSocket 同时存在
- 改进 MILKY_URL 校验错误信息，明确指出配置缺失
- 修复 frontmatter 解析仅支持 LF 的问题，现支持 CRLF 和末尾无换行
- 修复 `ensureGroupDir` 不修复已有目录缺失文件的问题，现会自动补全缺失的子目录和默认文件

## [0.0.5] - 2026-01-12

### Added

- 多平台适配器工厂（`src/adapters/factory.ts`）
  - `createAdapter()` 函数根据配置动态创建平台适配器
  - 支持 `PLATFORM` 环境变量选择平台（`qq` | `discord`）
- 配置扩展
  - `PLATFORM` 平台选择，默认 `qq`
  - `DISCORD_TOKEN` Discord Bot Token（预留）
  - `DISCORD_APPLICATION_ID` Discord 应用 ID（预留）

### Changed

- `src/index.ts` 使用 `createAdapter(config)` 替代硬编码的 `new QQAdapter()`
- `QQAdapter` 移除对全局 config 的直接依赖，url 通过构造函数传入
- `MILKY_URL` 改为可选配置（由工厂函数验证）

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
