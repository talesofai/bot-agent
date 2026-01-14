# 分布式 Opencode 架构设计 (User-Isolated)

## 1. 核心目标

在 **仅使用 NAS 共享存储** 的前提下，实现 **多机水平扩展**，并保证 **用户会话隔离**。

- **User-Exclusive**: 一个 Session 严格对应一个用户 (User)，不可多人共享。
- **No Merging**: 不进行复杂的自动化归档与合并。Session 产物主要用于当前交互或由管理员/Bot 显式处理。
- **Admin Managed**: 核心规则 (`skills/`) 与 静态资源 (`assets/`) 由管理员或 WebUI 维护，Opencode 不自动修改。

## 2. 核心架构决策

1.  **数据隔离 (Isolation)**:
    - **Group 级**: 物理目录隔离。
    - **Session 级**: 目录 `sessions/{sid}` 为执行单元。
      - **命名规范**: `{userid}-{key}` (默认 key=0)。
      - **多重会话**: 支持 `key` 扩展 (需配置开启)，允许同一用户拥有多个并行宇宙。
    - **用户级**: 逻辑强制检查，确保 Session 归属单一用户。

2.  **权限模型 (Permissions)**:
    - **Opencode (运行态)**:
      - **RW**: 仅限当前 `sessions/{sid}/workspace/`。
      - **RO**: `agent.md`, `config.yaml`, `skills/`, `assets/`。
      - **Forbidden**: 其他 Session 目录。
    - **Bot/System**: 管理 Session 生命周期 (创建/销毁)。
    - **Admin/WebUI**: 修改 `agent.md`, `skills/` 等全局配置。

3.  **并发模型**:
    - **用户锁**: 基于 `sid` (`{userid}-{key}`) 加锁。不同 key 的 session 可并行。
    - **全局并发**: 只要 Session ID 不同，完全并行。

## 3. 目录结构规范

```text
/data/groups/{group_id}/
├── agent.md                # [RO] 群人设 (Admin可改)
├── config.yaml             # [RO] 群配置 (Admin可改)
├── skills/                 # [RO] 技能/规则库 (Admin可改)
├── assets/                 # [RO] 静态资源 (Admin可改)
│   └── images/
└── sessions/               # [System RW]
    └── {session_id}/       # [Opencode RW] 用户独占工作区
        ├── history.sqlite  # 会话历史
        ├── meta.json       # { sessionId, groupId, ownerId, key, status, createdAt, updatedAt }
        ├── workspace/      # Opencode CWD (工作目录，内部文件按需生成)
```

## 4. Session 生命周期 (Persistent Data, Transient Runtime)

Session 数据永久存在，但计算资源按需分配。即 **"Serverless"** 模式。

### 状态流转

`Active` (Running) <--> `Idle` (Stopped)

1.  **Resume (唤醒)**:
    - 用户发送消息。
    - System 检查 `sessions/{sid}` 是否存在。
    - 分配 Worker，挂载 `sessions/{sid}/workspace`。
    - 启动 Opencode 进程，加载上下文。

2.  **Process (处理)**:
    - Opencode 读取 Input -> 推理 -> 写入 Output。
    - **关键**: 每次唤醒都是以此前 `workspace/` 为基础的增量执行。

3.  **Halt (挂起)**:
    - 单次交互完成 (或超时)。
    - Opencode 进程退出 (释放内存/CPU)。
    - `sessions/{sid}` 数据完全保留，等待下次唤醒。

4.  **Purge (清理)**:
    - 仅当用户明确重置或极长时间未活跃 (TTL > 30天) 时，才会物理删除 Session 目录。

### 并发与锁

- **用户级互斥**: 同一用户的 `sid` 在同一时刻只能被一个 Worker `Resume`。
- 需要分布式锁吗？**需要**。
  - 锁位置: Redis (`session:lock:{groupId}:{sessionId}`)
  - 作用: 防止两个 Worker 同时 Resume 同一个 Session (例如用户快速连发)。
  - 释放策略: 仅删除自身设置的锁值，避免误释放他人锁。

## 5. 部署模型 (Worker Pool)

采用 **Worker Pool** 模式，而非 "1 Session = 1 Pod"。

### 架构

- **Workload**: 一组常驻的 Worker Pods (Deployment)。
- **Scaling**: 基于 CPU 利用率或队列深度 (KEDA) 进行 HPA 自动伸缩。
- **Loop**: 每个 Worker 进程并发运行 N 个 (e.g. CPU Core 数) 任务循环。

### 锁竞争处理 (Lock Contention)

当 Worker 获取任务但发现 Session 被锁 (Session Busy) 时：

- **错误做法**: `while(locked) sleep()` (资源浪费)。
- **正确做法**: **NACK / Re-queue**。
  - 立即释放当前 Job，将其扔回队列尾部 (或延迟重试)。
  - Worker 立即释放线程去处理下一个 Job。

## 6. 关键变更 (vs 旧方案)

- **移除 Archive Agent**: 不再有自动归档进程。
- **移除 Merge Flow**: 不再尝试合并知识回 `assets/`。
- **移除 Group Lock**: 只有创建 Session 时可能需要简易互斥，运行时完全无锁。

## 7. 扩展性

此架构天然支持无限水平扩展，因为没有任何跨 Session 的写竞争。
唯一的瓶颈是 NAS 的 IOPS。
