# Changelog

本项目的所有重要变更都会记录在这个文件中。

格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.0.0/)，
版本号遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### Added

- 文档：新增 0.0.29 Vision（配置语义收敛与可测试性）
- Opencode：新增全局技能 `url-access-check`（脚本校验 URL/图片可访问性），并在每次运行前同步到会话 workspace 的 `.claude/skills/`，避免输出“不可用链接”
- 测试：新增 RouterStore 默认配置与 bot 配置落盘用例
- History：将 opencode 事件流中间态写入 Postgres（`includeInContext=false`），便于追踪但默认不进上下文
- Discord：AI 处理期间发送 typing indicator（“正在输入”状态）

### Fixed

- Router：Adapter 启动初始化 `/data/router/global.yaml`；首次遇到 botId 时创建 `/data/bots/{botId}/config.yaml`，与目录结构文档一致
- Discord：支持“回复 bot 消息”触发（不需要额外 @ mention），避免对话链断掉
- Discord：即使消息内容被裁剪/缺失，仍可通过 mentions 元数据识别 @bot 触发，避免“@ 了但不入队”
- 输出：识别 Markdown/裸图片链接并按富内容发送（Discord embed / QQ image segment），确保“图片”不是纯链接
- Discord：对外链图片尝试下载并以附件发送（best-effort），避免部分站点禁用 embed 导致“只有链接没图片”
- Discord：外链图片不可下载/非图片响应时丢弃该图片元素，避免出现“空图片框”
- HTTP：adapter/worker 默认使用不同端口（新增 `WORKER_HTTP_PORT`，默认 8081），避免本地同机多进程端口冲突
- Opencode：prompt file 以 `--file` 追加到 message 之后，避免被 CLI 误当作文件列表吞掉导致 `opencode run` 直接失败
- Opencode：支持解析 `--format json` 的事件流输出（text chunks），确保能提取最终回复
- Opencode：外部模式使用自定义 chat agent，避免在无交互环境卡在权限询问/工具执行
- Opencode：system prompt 永远追加 URL 可用性校验硬性规则（`url-access-check`），避免模型编造/输出不可用链接
- Session：会话目录按 `{botId}/{groupId}/{userId}/{sessionId}` 分桶，消除跨群复用导致的 workspace 竞争与 `groupId` 不一致补丁逻辑
- Config：加载 `.env` 时忽略空字符串配置，避免 optional 数值项被 `"" -> 0` 误解析触发校验失败
- K8s：`bot-data` 改为 NAS RWX（`alibabacloud-cnfs-nas`），避免 adapter/worker 分布到不同节点时触发 Multi-Attach
- K8s：worker 注入 `DISCORD_TOKEN`，确保 Discord 消息可由 worker 正常回复
- 文档：README 补充历史/记录存放位置并修正 data 目录结构说明（移除 `history.sqlite` 描述，历史仅写入 Postgres）
- Session：处理缓冲消息失败时回滚并 `requeueFront`；发送失败会让 job 失败以触发 BullMQ 重试，避免消息丢失/静默失败

### Changed

- Opencode：默认强制使用 `opencode/glm-4.7-free`；仅在同时设置 `OPENAI_BASE_URL` + `OPENAI_API_KEY` + `OPENCODE_MODELS` 时启用外部模式（litellm），并自动生成 `~/.config/opencode/opencode.json` 与 `~/.local/share/opencode/auth.json`
- Opencode：默认使用 yolo chat agent（全工具/全权限 allow）；可通过 `OPENCODE_YOLO=false` 降低权限（将不再显式指定 agent）
- Opencode：system prompt 兜底改为更通用的默认提示词；私聊（groupId=0）默认也使用 `configs/default-agent.md`（如果存在）
- 默认 Agent：更新为“奈塔”人设（称呼“捏捏老师”，回复结尾带“捏”，图片用 Markdown `![...](...)`）
- 配置/部署：移除 `configs/secrets/.env`，统一使用单一 `configs/.env`（Compose/脚本/K8s/文档同步）
- 配置：`DEFAULT_GROUP_ID` 更名为 `FORCE_GROUP_ID`，避免误解为“默认值”（示例配置默认注释并补充说明）
- K8s：opencode-bot-agent 默认镜像改为阿里云仓库（`registry.cn-shanghai.aliyuncs.com/talesofai/opencode-bot-agent:latest`）

### Security

- 部署：补齐 `pmhq` 需要 `privileged: true` 的原因说明，并明确最小权限目标（`SYS_PTRACE` + `seccomp=unconfined`）
- Opencode：外部模式使用临时 `HOME` 生成配置并在结束后清理，避免 API Key 落盘到宿主机目录

## [0.0.28] - 2026-01-16

### Added

- 多平台组合适配器，同时连接 QQ 与 Discord，消息处理链保持一致
- 新增 PostgreSQL 的 K8s StatefulSet 清单（`deployments/k8s/postgres.yaml`）
- 新增 CI：push/PR 运行 lint + test + typecheck（`tsc --noEmit`）

### Changed

- 提供 `DISCORD_TOKEN` 时自动启用 Discord（无需 PLATFORM/PLATFORMS）
- 会话/缓冲/任务/机器人配置使用 `{platform}-{canonicalBotId}` 作为 botId，避免跨平台 id 冲突
- K8s 清单默认使用通用镜像名 `opencode-bot-agent:latest`，部署时用 `kubectl set image` 切换为阿里云镜像
- Redis 的 K8s 清单改为 StatefulSet + PVC，避免重启丢数据
- K8s：worker 注入 `OPENAI_BASE_URL`（从 `llbot-secrets`），支持通过 LiteLLM 等代理改写 OpenAI Base URL

### Fixed

- Docker 镜像默认 CMD 改为 `bun run start:adapter`，避免缺少 `start` 脚本导致容器退出
- 默认 `agent.md` 模板改为读取 `configs/default-agent.md`，移除代码硬编码，确保行为可控且文档一致
- 文档：修正“群目录需预创建否则不入队”的描述，实际行为为自动创建并继续处理
- 修复 TypeScript 类型检查：事件元素改为只读并补齐 QQ 事件解析与历史 meta JSON 序列化
- CI：移除 `opencode-ai` 作为项目依赖，避免 bun 在 Linux 环境安装 optional deps 失败
- BullMQ：buffer 追加与是否需要新 job 改为 Redis 原子 gate，消除入队竞态窗口
- BullMQ：gate TTL 仅由 worker 心跳续期，避免 job 失败后被消息延长导致会话卡死
- SessionProcessor：opencode 运行后校验 gate ownership，gate 变更时回滚 drain 的缓冲并跳过写历史/回复，避免过期 job 产生副作用
- K8s：移除旧版 `luckylillia`/`pmhq` Deployment 清单并更名 `bot-data` PVC 清单，避免与 `llbot` StatefulSet 同目录误 apply 打架
- K8s：PVC 显式指定 ACK StorageClass（`alicloud-disk-topology-alltype`）并将 Postgres/Redis 数据盘最小值提高到 20Gi，避免无 default StorageClass / 最小盘限制导致 Pending/ProvisioningFailed
- K8s：Postgres 设置 `PGDATA=/var/lib/postgresql/data/pgdata`，避免 PVC 根目录 `lost+found` 触发 `initdb` 启动失败
- 文档：机器人关键词配置路径改为 `/data/bots/{platform}-{canonicalBotId}/config.yaml`，与代码一致
- 文档：修复开发指南代码块 fence 并更新接口示例签名，确保与实际类型一致
- 文档：更新 `AGENTS.md`，移除“TS 在规划中”的错误描述并补齐 `bun run`/Docker Compose 真实命令
- Session TTL 清理：lastActive 改为读取 meta.updatedAt，避免目录 mtime 不更新导致误删
- SessionActivityStore：移除未使用的 `fetchExpired`/`remove` 半成品接口，避免维护噪音
- 测试：新增 SessionProcessor 缓冲尾部竞态回归用例，防止消息滞留/丢失回归
- Docker：补齐 `.dockerignore` 并收敛 Dockerfile 复制范围，避免把本地 `data/` 与 `.env` 等打进镜像
- Docker：`opencode-linux-x64` 改为 `@latest`，避免与 `opencode-ai@latest` 混用导致版本漂移
- Typecheck：关闭 `skipLibCheck` 并补齐 `node:util`/`node:tls` 类型兼容层，确保 `tsc --noEmit` 全量检查通过
- TypeScript：移除 `tsconfig.json` 中无关的 `jsx`/`allowJs` 选项，减少配置噪音
- Docker Compose：移除无效的 `PLATFORM=qq` 配置，避免误导（代码不读取该 env）
- Opencode：prompt 不再通过 argv 传递，改为临时文件注入并提供 `OPENCODE_PROMPT_MAX_BYTES` 上限，避免长度上限与进程列表泄露风险
- HTTP API：管理端点仅在设置 `API_TOKEN` 时启用，并要求 Bearer/`X-API-Token` 认证；文档同步更新

## [0.0.27] - 2026-01-15

### Added

- PostgreSQL 历史存储（`PostgresHistoryStore`），按 `bot_account_id + user_id` 读写并记录 `groupId`
- 新增 `DATABASE_URL` 配置，用于连接 PostgreSQL
- 新增 `BOT_ID_ALIASES` 映射，支持继承者 botId 复用旧目录
- 新增 `HISTORY_MAX_ENTRIES` / `HISTORY_MAX_BYTES` 配置，限制历史窗口

### Changed

- 文档：新增历史与路由设计说明并更新相关架构/配置描述
- 文档：新增配置存储与缓存策略 ADR
- 文档与部署：补齐 PostgreSQL 的启动与注入说明（Docker Compose/K8s）
- 群聊分发恢复使用 guildId 作为 groupId，避免不同频道共享配置与上下文
- 会话目录迁移至 `sessions/{botId}/{userId}/{sessionId}`，按 canonical botId 隔离并允许继承
- QQ 路由缺失时发送消息改为记录告警并跳过
- SessionWorker 默认使用 PostgreSQL 历史存储（`DATABASE_URL` 必填）
- 测试脚本改为 `bun test ./src`，避免误跑 `example/` 下游工程的测试
- 会话缓冲与任务去重键增加 `botId + groupId` 维度，避免跨群/跨 bot 串话与误合并
- 私聊强制使用 `groupId=0`，并默认始终入队处理（不再依赖群触发规则）
- Prompt 的 History 行追加 `groupId` 标记，确保跨群共享历史时可区分来源
- 历史记录查询按 canonical botId 聚合并按时间倒序截取，History 行显示 `group:xxx`/`dm:0` 上下文
- 集成测试自动探测可用的 Redis/Opencode 二进制，有依赖即运行，无依赖则跳过并保留单测
- Docker 镜像改用 Ubuntu 基础镜像，并以 `bun install -g opencode-ai` 安装 CLI 修复构建失败

## [0.0.26] - 2026-01-15

### Changed

- 会话历史存储切换为 SQLite 文件
- 历史文件后缀更新为 history.sqlite
- 缓冲消息合并格式移至 opencode 提示词构建
- 注册表监听改为 Redis Pub/Sub 与键事件通知
- 会话清理只依赖文件系统，移除 Redis 索引
- Opencode 输出解析改为单次 JSON block 扫描
- trimTextElements 减少多余分配与空白扫描
- 历史记录 extra 解析与 QQ payload 解析改为安全对象判断
- SessionWorker 直接发送消息，移除 ResponseQueue/ResponseWorker
- opencode-ai 依赖升级至 1.1.20
- 解析层过滤纯空白文本节点，trimTextElements 简化为 filter/map
- Opencode 输出解析改为扫描 JSON 块并择优解析
- 注册表监听改为前缀 Keyspace 通知并合并刷新请求
- 会话清理以目录 mtime 作为唯一活跃度来源
- 缓冲消息的提示词格式化改由 opencode 输入构建负责
- QQ 事件解析使用 Zod 校验核心字段
- Session meta 读取改用 Zod 校验结构
- Opencode 输出解析移除不安全对象断言
- 注册表条目解析改用 Zod 校验结构
- SessionWorker 下沉会话处理逻辑至 SessionProcessor

## [0.0.25] - 2026-01-15

### Changed

- trimTextElements 改为无变异 slice 裁剪，减少分支
- Discord 解析改为直接使用原始内容与 mentions 列表
- 触发器移除平台分支，统一依赖元素化 mention 判断
- Discord 解析补齐 mention 元素，避免核心逻辑读取 extras
- Adapter 启动路径移除工厂层，直接在入口构造平台适配器
- SessionManager 拆除为显式仓储与 createSession 辅助函数
- SessionWorker 拆分缓冲处理与上下文构建，主流程更直观
- Worker 去掉 Redlock 续期与锁依赖，依赖队列去重触发
- Discord 发送优先使用缓存并处理 channel fetch 失败
- EchoTracker 改为 Redis 共享状态，避免本地内存失效
- Worker 锁逻辑抽离为独立封装，精简业务流程
- 历史记录读取改为 Bun.file slice 读取尾部窗口并按需解析
- 会话入队改为 Redis 缓冲并合并消息批处理

## [0.0.24] - 2026-01-14

### Fixed

- reload 接口校验 groupId 为安全路径段
- 群/用户/会话标识强制安全路径段校验，避免目录穿越与非法路径
- 会话元数据与活跃度索引校验，避免加载或保留异常会话
- llbot 注册索引清理修正前缀与批量移除

### Changed

- 群配置解析失败时回退默认配置并记录错误
- 会话清理优先使用活跃度索引并补齐收尾清理
- Discord/QQ 解析、发送与连接处理逻辑调整
- 触发/复读逻辑与消息分发路径优化
- Opencode 输出解析支持日志混排 JSON
- Worker 任务处理与队列写入更严格的空输入/中止控制
- Adapter 启动流程提前失败退出并确保初始化
- TypeScript 配置与 Redlock 类型补齐
- trimTextElements 去除 splice 操作并简化裁剪流程
- 触发规则预先合并关键词，精简 shouldEnqueue 逻辑
- Discord 解析提及元素时校验真实 mentions
- 群配置与 agent.md 读取失败时直接抛错
- 会话锁续期失败时记录明确的丢锁日志

## [0.0.23] - 2026-01-14

### Added

- Discord 适配器（discord.js），补齐多平台支持

## [0.0.22] - 2026-01-14

### Added

- llbot 注册器脚本，定期写入注册表并设置 TTL
- 复读概率配置 `echoRate`（全局/群/机器人可回退）
- echoRate 回退与 llbot 注册器刷新路径的测试覆盖
- 独立入口脚本：`start:adapter` / `start:worker`

### Changed

- llbot 注册表读取不再依赖 `lastSeenAt` 过滤
- 复读逻辑跳过所有包含 @ 的消息
- llbot 注册器在刷新间隔大于等于 TTL 时直接报错
- 复读关闭时仍更新 streak，避免状态陈旧
- Opencode 输出严格要求 JSON，拒绝混杂日志
- 群配置移除文件监听，新增手动重载接口
- 历史记录读取改为文件尾部读取，避免外部进程
- 自身提及正则缓存，减少热路径开销
- Worker 统一写入用户与助手记录，移除历史猜测逻辑
- 消息分发逻辑抽离到 MessageDispatcher，入口仅负责装配
- 触发器内部完成关键词匹配，避免外部组装匹配结果
- QQ 连接等待增加超时，避免挂起
- QQ 连接状态简化为已连接/已断开，降低竞态分支
- 会话锁改为 Redlock 并自动续期，降低并发冲突风险
- 历史记录尾部读取优化换行统计与截断，减少无用扫描
- 会话清理改为磁盘扫描，并同步清理索引
- 增加独立会话清理脚本 `clean:sessions`
- 增加会话清理 CronJob 示例
- 拆分 adapter 与 worker 启动入口，移除 `SERVICE_ROLE`
- 新增 adapter/worker 部署清单示例
- 部署文档更新 adapter/worker 与清理任务应用命令
- 文档更新本地启动与日志查看命令
- Docker Compose 补充 adapter/worker 启动示例
- llbot-local compose 增加 adapter/worker 与 redis
- 更新入门文档关于 compose 启动说明
- llbot 注册表改用索引集合避免 Redis 全表扫描
- 历史记录输出增加精确时间与星期信息
- 历史读取改为全量读取并截断末尾行
- Worker 配置参数分组，减少构造函数噪音
- SessionManager 移除可注入 activity tracker，改由 Worker 记录活跃度
- 活跃度记录移除 recorder 包装层，直接使用 SessionActivityIndex
- 活跃度存储命名更清晰，SessionActivityStore 替代 Index
- 会话 key 类型命名简化为 SessionKey

### Fixed

- 修正复读概率单测的期望值
- 复读在 @ 消息时重置 streak

## [0.0.21] - 2026-01-13

### Fixed

- 关键词路由不再因其他 bot 关键词命中而阻断全局/群关键词
- 群配置解析失败时直接报错，避免静默回退默认值
- llbot 注册表读取支持 TTL 过滤过期条目

## [0.0.20] - 2026-01-13

### Changed

- 重构 QQ 适配为基于 Redis 注册表的多 Bot 连接池
- 触发路由改为 mention 优先 + 关键词路由开关组合策略
- 群配置移除 cooldown 与 triggerMode=all
- 配置与文档补齐 llbot 注册表与数据目录说明
- K8s 资源补齐 llbot StatefulSet 与多实例 Service

### Added

- Redis 注册表读取模块
- 关键词路由配置加载与缓存存储
- 复读触发检测
- Redis 部署模板与多 Bot 架构 ADR

## [0.0.19] - 2026-01-13

### Changed

- K8s 资源统一使用 `bot` 命名空间并调整 PVC 名称
- WebUI Token 生成与启动过程强制非空配置
- 示例配置默认 Token 置空，避免误用默认值
- 部署文档同步 `bot-namespace.yaml` 与命名空间变更

### Added

- `pmhq` Service 与端口声明，完善 K8s 内部通信

## [0.0.18] - 2026-01-13

### Changed

- 平台消息模型改为 SessionEvent 并更新 QQ 适配与队列
- 开发计划文档对齐 SessionEvent 抽象
- 增加 opencode 集成测试并补充运行说明
- 增加 response worker Redis 集成测试并补充运行说明
- 增加 session worker Redis 集成测试
- 开发文档更新 Session 事件结构
- 开发文档补充 OPENCODE_BIN 用法

## [0.0.17] - 2026-01-13

### Fixed

- SessionHistory 追加逻辑避免重复 user 记录
- 当 history 无 assistant 记录时追加输出内容
- Session key 校验负数输入
- SessionWorker 重试延迟使用配置值
- GroupWatcher 忽略 sessions 目录变更，避免无意义重载
- SessionHistory 读取 tail 为空时直接返回空列表
- SessionHistory 读取前检查文件存在，避免 tail 误报
- 仅在 adapter 角色下强制平台配置校验
- Response 队列使用原始 channelId，避免 `FORCE_GROUP_ID`（原 `DEFAULT_GROUP_ID`）误投递
- Session lock key 追加 groupId，避免跨群冲突
- GroupStore 加载失败时清理缓存，避免旧配置残留
- History 追加仅在匹配内容时跳过，避免遗漏当前消息
- GroupWatcher 监听删除事件，确保清理后重载
- SessionRepository 使用统一的 sessionId 构造逻辑
- GroupConfig 的 model 覆盖 OPENCODE_MODEL
- Session lock 使用随机值并对比删除，避免误释放他人锁
- 复用已有 session 时刷新活跃索引
- Session lock 释放失败时记录警告而不中断任务
- ResponseJobData 强制 channelType，避免隐式默认值
- 队列 enqueue 移除多余的 payload 复制
- Session key 前缀支持仅包含编号的输入
- 文档更新群配置示例字段与类型
- Agent customization 文档同步群配置字段
- GroupStore 读取异常时清理缓存
- 配置文档说明默认 agent.md 生成行为
- 配置文档更新群目录结构为实际会话存储布局
- 架构与计划文档统一群目录结构为 sessions
- 架构文档补充会话工作目录说明
- 入队时强制携带 channelType，避免默认落入群消息
- 配置文档中的占位示例移除未实现字段
- 开发文档补充 UnifiedMessage 的 channelType 字段
- 群目录创建移除未使用的 context 目录
- 配置文档补充群目录需预创建的说明
- 群目录创建补齐 assets/images 子目录
- 架构文档对齐 opencode 启动参数
- 分布式设计文档对齐 Redis 锁实现
- 架构文档更新存储层描述为会话历史
- 架构文档更新 Agent 技术选型描述
- 配置文档补充平台与 Discord 环境变量
- 示例环境变量文件补充平台配置
- 开发文档补充 PlatformAdapter 连接事件回调
- 开发计划文档更新 AI 调用方案为 opencode
- 开发计划任务列表改为 opencode runner 与输出解析
- 分布式设计文档移除未使用的会话锁文件描述
- 快速开始文档更新 AI 回复说明
- 快速开始文档补充本地启动 opencode-bot-agent 说明
- 分布式设计文档更新 meta.json 字段说明
- 补齐 secrets 模板文件供初始化脚本使用
- 配置文档补充平台必填项说明
- secrets 文档补充 Discord token 示例
- 部署文档补充平台相关环境变量示例
- 部署文档对齐 K8s secret 名称
- 配置示例中的 adminUsers 使用字符串类型
- README 更新群目录结构示例
- README 补充 sessions/history.jsonl 并标注 config.yaml 为占位模板
- Agent customization 文档标注 config.yaml 占位与 sessions/history.jsonl
- 文档纠正群目录 config.yaml 为实际配置
- 开发计划文档补充 sessions/history.jsonl 示例
- API 文档标注群管理与技能接口为规划中
- 开发计划文档对齐 HTTP API 路径与 Bun.serve 选型
- Agent customization 文档说明 agent/config 已支持、skills 注入仍规划中
- 配置文档移除热更新章节的“规划”标记
- Agent customization 文档补充管理指令为规划中
- 配置文档澄清主配置仅支持环境变量
- API 文档状态描述对齐仅健康检查已实现
- 开发计划文档标注 Discord 适配仍在规划中
- 架构文档移除 Discord 生态成熟的表述
- 架构文档标注 Discord/Telegram 适配器规划中
- 开发计划文档标注 Discord 适配器规划中
- 0.0.4 计划文档补充历史计划说明
- 0.0.3/0.0.5/0.0.7 计划文档补充历史计划说明
- 0.0.6/0.0.8/0.0.9 计划文档补充历史计划说明
- 0.0.10-0.0.17 计划文档补充历史计划说明
- README 标注技能注入仍在规划中
- 部署文档补充指标端点尚未提供
- 快速开始文档补充本地运行需确认 PLATFORM=qq
- README 补充技能注入仍在规划中
- 配置文档补充 CONFIG_PATH 路径解析说明
- 配置文档移除群配置的“可选”描述
- 开发文档对齐 OpenAI_BASE_URL 环境变量命名
- 配置文档补充 SERVICE_ROLE 影响平台配置要求
- 示例环境变量标注 Discord 配置为 PLATFORM=discord 必填
- 部署文档标注 Discord 配置为规划
- secrets 文档标注 Discord Token 为规划
- 示例环境变量补充 worker 角色的配置说明
- 配置文档标注默认技能列表为规划
- 配置文档澄清 agent.md 生成时机
- 配置文档标注 Discord 环境变量为规划
- 部署文档与 secrets 示例标注 Discord 配置为规划
- 示例环境变量标注 Discord 配置为规划
- secrets 文档补充 Discord 应用 ID 标注为规划
- 配置文档澄清 Discord 平台报错条件
- 配置文档补充 APP_VERSION 环境变量说明
- 示例环境变量补充 APP_VERSION 配置
- secrets 文档标注 gitleaks 扫描未启用
- Agent customization 文档补充会话 key 前缀说明
- 部署文档澄清 K8s 基础资源覆盖范围
- 快速开始文档补充会话 key 前缀说明
- 配置文档说明 cooldown 为群级冷却
- API 文档补充 cooldown 为群级冷却
- Agent customization 文档标注角色配置路径为规划
- Agent customization 文档补充技能示例为格式说明
- 开发计划文档标注 Discord 技术栈为规划
- 配置文档对齐热更新监听器说明
- API 文档示例对齐当前群配置字段
- History 追加判断基于最新 assistant 前的 user 记录
- 移除文档中未实现的群配置环境变量
- 配置文档移除未生效的重连与 MCP 超时配置项
- Agent customization 文档标注未实现的管理指令
- 配置文档移除未生效的并发配置项
- 配置文档修正日志格式选项
- 读取群配置前确保目录与默认文件
- History 追加判断逻辑简化以减少分配
- 开发计划文档依赖列表改为以 package.json 为准
- 配置文档补充 Discord Adapter 未实现的说明
- 文档与示例环境变量统一 Milky WebSocket 地址格式
- API 文档标注 WebSocket 接口为规划中
- 快速开始文档补充本地运行所需的 Redis 地址说明
- 文档中的群目录结构补充 assets/images 子目录
- 配置文档标注 config.yaml 仍为占位模板
- 文档补充本地启动时加载 secrets 环境变量说明
- 部署文档目录结构补充 secrets 环境文件
- secrets 文档补充导出 secrets 环境变量示例
- 部署文档更新 Bot Agent 状态描述
- 开发计划文档更新 opencode 仓库链接
- 分布式设计文档补充 assets/images 目录
- 架构图标注 Milky WebSocket
- 分布式设计文档补充 history.jsonl 说明
- 分布式设计文档说明 workspace 内部文件按需生成
- API 文档标注认证为规划中，并补充 API_TOKEN 说明
- Agent customization 文档补充 assets/characters 说明
- 快速开始文档说明 compose 未包含 Bot Agent
- Agent customization 文档标注角色配置加载为规划中
- 部署文档 compose 示例对齐实际路径
- 架构文档标注 Milky WebSocket 术语
- README 与配置文档标注默认技能仍在规划中
- 配置文档标注主配置文件仍为规划
- 部署文档调整 Docker Compose 状态描述
- 开发计划文档统一 Milky WebSocket 术语
- 文档标注 /reload 管理指令与接口为规划中
- 快速开始文档补充 opencode CLI 本地依赖说明
- 快速开始文档补充 opencode CLI 前置要求
- 配置文档补充 GROUPS_DATA_DIR 持久化提示
- API 文档示例版本号对齐当前版本
- 架构文档标注 skills 注入仍在规划中

### Changed

- SessionRepository 移除未使用的路径字段
- Opencode 启动参数结构精简
- 开发文档中的测试命令更新为 `bun test src`
- Opencode 启动时追加 `OPENCODE_MODEL`
- GroupStore 初始化失败时记录错误日志
- 仅在 adapter 角色初始化 GroupStore
- 读取 agent prompt 前修复群目录缺失文件
- adapter 启动时启用 GroupStore 文件监控
- 精简占位配置中的未实现字段

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
- 强制群聊 groupId 覆盖支持（`FORCE_GROUP_ID`，原 `DEFAULT_GROUP_ID`）

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
- 配置模板（`configs/config.example.yaml`、`configs/default-agent.md`、`configs/example.env`）
- Claude Code 时间查询技能（`.claude/skills/time-lookup/SKILL.md`）
- Claude Code 技能生成与优化技能（`.claude/skills/skill-authoring/SKILL.md`）
- 技能模板与校验脚本（`.claude/skills/skill-authoring/assets/skill-template/SKILL.md`、`.claude/skills/skill-authoring/scripts/validate_skill.sh`）
- Secret 初始化与轮换脚本
- LuckyLilliaBot/Milky 的 Docker Compose 与 K8s 部署资源
- 完整文档体系（架构、部署、配置、开发计划等）
