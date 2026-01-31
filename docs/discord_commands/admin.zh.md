# 管理与会话指令

本页覆盖会话与管理类指令：`/reset`、`/resetall`、`/model`（以及对应的消息版本）。

## `/reset [key] [user]`

创建新的 session（相当于“换一段新对话上下文”）。

- `key`：会话槽位（默认 0；必须是非负整数）
- `user`：要重置的用户（默认自己；**仅管理员可指定他人**）

示例：

```text
/reset
/reset key:2
/reset key:0 user:@someone
```

消息版本（同义）：

```text
/reset
#2 /reset
```

## `/resetall [key]`（仅管理员）

重置全群对话（按槽位 key）。

示例：

```text
/resetall
/resetall key:1
```

消息版本（同义）：

```text
/reset all
#1 /reset all
```

## `/model name:<modelId|default>`（仅管理员）

切换群模型覆盖：

- `default`：清除群配置里的 model 覆盖，回到默认选择
- `<modelId>`：必须在 `OPENCODE_MODELS` 白名单内（允许包含 `/`）

示例：

```text
/model name:default
/model name:vol/glm-4.7
```

消息版本（同义）：

```text
/model default
/model vol/glm-4.7
```
