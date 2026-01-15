# ADR-005: 配置存储与缓存策略

## 状态

已接受

## 背景

系统存在三类配置与数据：

1. 全局配置（system prompt、skills、mcp、tools）
2. 群配置（group prompt、skills、mcp、tools）
3. 用户与会话的可变数据（历史、偏好、授权、状态）

全局与群配置绝大多数时间为只读，且需要人工可编辑；历史与用户状态需要强一致与并发写入。

## 决策

1. **全局与群配置存储在文件系统**，便于人类编辑与版本管理。
2. **Redis 仅用于路由与热缓存**，缓存编译后的 prompt/skills 结果与配置 hash。
3. **数据库（PostgreSQL）只存可变状态**，包括历史与用户/授权/工具状态。

## 目录结构

```
/data/
├── global/
│   ├── agent.md
│   ├── config.yaml
│   ├── skills/
│   ├── mcp/
│   └── tools/
├── groups/{group_id}/
│   ├── agent.md
│   ├── config.yaml
│   ├── skills/
│   ├── mcp/
│   └── tools/
└── users/{user_id}/
    ├── preferences.json
    └── state.json
```

## Redis 缓存

仅缓存只读配置的“热路径”结果，避免频繁磁盘读取。

示例：

```
GET global:config:hash
GET group:{group_id}:hash
GET global:compiled_prompt
GET group:{group_id}:compiled_prompt
```

## 数据库职责

- history_entries（按 userId + bot_account_id）
- 授权与用户状态（可选）
- 迁移与继承记录（可选）

## 结果

优点：

- 只读配置可读性高、易维护、易版本化
- 写路径集中在数据库，事务一致性可控
- Redis 仅做缓存和路由，避免状态漂移

代价：

- 配置变更需要刷新 Redis 缓存（或依赖 hash 检测）
- 需要约定全局与群目录的落地路径
