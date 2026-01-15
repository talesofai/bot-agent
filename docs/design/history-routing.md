# 历史与路由设计（Eridanus 风格）

本文档定义历史记录与 llbot 路由的目标设计。核心目标：**历史按用户共享、按 bot 账号隔离，路由只走 Redis**。

## 核心规则

1. **Session = userId**
   - 历史记录以用户为核心，不再按群拆分。
2. **跨群共享历史，但必须可识别来源**
   - 每条历史记录必须携带 `groupId`。
3. **bot 账号隔离历史**
   - 不同 QQ/Discord 账号的 bot **不共享历史**。
4. **继承迁移允许但必须是“新账号无记录”**
   - 迁移是全量覆盖，不做合并。
5. **路由不进数据库**
   - llbot 路由只放 Redis，数据库完全不关心 llbot 实例。

## 身份定义

### bot_account_id

用于隔离历史的数据键：

```
bot_account_id = "{platform}:{account_id}"
```

示例：

```
qq:12345678
discord:987654321
```

### groupId 规则

- 私聊：`groupId = "0"`，不注入任何群配置。
- 群聊：`groupId != "0"`，注入对应群的 system prompt / skills / mcp / tools。

## 数据存储（PostgreSQL）

### history_entries（append-only）

```
history_entries(
  id BIGSERIAL PRIMARY KEY,
  user_id TEXT NOT NULL,
  bot_account_id TEXT NOT NULL,
  group_id TEXT NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TIMESTAMP NOT NULL,
  meta JSONB NULL
)
```

读取历史（用户维度 + bot 隔离）：

```
SELECT *
FROM history_entries
WHERE user_id = :user_id AND bot_account_id = :bot_account_id
ORDER BY id DESC
LIMIT :max_entries;
```

## llbot 路由（Redis）

路由只存在于 Redis，数据库不关心实例归属。

```
HSET bot:route:{bot_account_id} llbot_ordinal 3 ws_url ws://llbot-3... updated_at ...
EXPIRE bot:route:{bot_account_id} 30
```

路由流程：

1. 主服务解析 `bot_account_id`
2. Redis 查路由
3. 投递到对应 llbot

## Prompt 注入

### 规则

- 历史：按 `user_id + bot_account_id` 读取
- 群上下文：按 `groupId` 注入
  - `groupId = 0`：空上下文

### 建议格式

历史条目在 prompt 中标记来源：

```
user [2026-01-15 12:00:00 group:123]: ...
assistant [2026-01-15 12:00:01 group:123]: ...
```

## 继承迁移（全量）

**条件**：新 bot 账号在系统中无任何记录。  
**行为**：旧账号所有数据迁移至新账号（历史、偏好、工具状态、授权等）。

示例事务：

```
BEGIN;
SELECT COUNT(*) FROM history_entries WHERE bot_account_id = :new_id;
-- count > 0 直接拒绝
UPDATE history_entries
SET bot_account_id = :new_id
WHERE bot_account_id = :old_id;
COMMIT;
```

## 与群配置的关系

群配置仍位于：

```
/data/groups/{group_id}/
```

仅用于 system prompt / skills / mcp / tools 注入。  
历史不再放在群目录下。
