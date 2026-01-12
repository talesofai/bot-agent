# API 参考

本文档为接口草案，部分接口仍在迭代中，以下内容用于规划与对齐需求。

> 状态：迭代中，接口与字段可能调整。

## HTTP API

Bot Agent 在 `8080` 端口提供 HTTP API。

### 健康检查

```http
GET /health
```

**响应**：

```json
{
  "status": "ok",
  "version": "1.0.0",
  "uptime": "2h30m15s"
}
```

### 指标

```http
GET /metrics
```

返回 Prometheus 格式的指标数据。

### 群管理

#### 列出所有群

```http
GET /api/v1/groups
```

**响应**：

```json
{
  "groups": [
    {
      "id": "123456789",
      "name": "测试群",
      "enabled": true,
      "memberCount": 50
    }
  ]
}
```

#### 获取群配置

```http
GET /api/v1/groups/{group_id}
```

**响应**：

```json
{
  "id": "123456789",
  "name": "测试群",
  "enabled": true,
  "triggerMode": "mention",
  "agentConfig": "# Agent 配置\n...",
  "skills": ["draw", "roleplay"]
}
```

#### 更新群配置

```http
PUT /api/v1/groups/{group_id}
Content-Type: application/json

{
  "enabled": true,
  "triggerMode": "mention"
}
```

#### 重载群配置

```http
POST /api/v1/groups/{group_id}/reload
```

### Agent 配置

#### 获取 Agent 配置

```http
GET /api/v1/groups/{group_id}/agent
```

**响应**：

```json
{
  "content": "# Agent 配置\n你是一个友好的助手..."
}
```

#### 更新 Agent 配置

```http
PUT /api/v1/groups/{group_id}/agent
Content-Type: application/json

{
  "content": "# 新的 Agent 配置\n..."
}
```

### 技能管理

#### 列出技能

```http
GET /api/v1/groups/{group_id}/skills
```

**响应**：

```json
{
  "skills": [
    {
      "name": "draw",
      "description": "AI 绘画技能"
    },
    {
      "name": "roleplay",
      "description": "角色扮演技能"
    }
  ]
}
```

#### 获取技能内容

```http
GET /api/v1/groups/{group_id}/skills/{skill_name}
```

#### 创建/更新技能

```http
PUT /api/v1/groups/{group_id}/skills/{skill_name}
Content-Type: application/json

{
  "content": "# 绘画技能\n当用户要求绘画时..."
}
```

#### 删除技能

```http
DELETE /api/v1/groups/{group_id}/skills/{skill_name}
```

## WebSocket API

Bot Agent 也支持 WebSocket 连接，用于实时事件推送。

### 连接

```
ws://localhost:8080/ws
```

### 事件类型

#### message

收到新消息时推送。

```json
{
  "type": "message",
  "data": {
    "groupId": "123456789",
    "userId": "987654321",
    "content": "Hello!",
    "timestamp": 1704067200
  }
}
```

#### response

AI 回复时推送。

```json
{
  "type": "response",
  "data": {
    "groupId": "123456789",
    "content": "你好！有什么可以帮你的吗？",
    "timestamp": 1704067201
  }
}
```

#### error

发生错误时推送。

```json
{
  "type": "error",
  "data": {
    "code": "agent_timeout",
    "message": "Agent 响应超时"
  }
}
```

## 错误响应

所有 API 错误返回统一格式：

```json
{
  "error": {
    "code": "invalid_request",
    "message": "群 ID 不能为空"
  }
}
```

### 错误码

| 错误码            | HTTP 状态码 | 说明           |
| ----------------- | ----------- | -------------- |
| `invalid_request` | 400         | 请求参数错误   |
| `not_found`       | 404         | 资源不存在     |
| `unauthorized`    | 401         | 未授权         |
| `forbidden`       | 403         | 权限不足       |
| `internal_error`  | 500         | 服务器内部错误 |

## 认证

API 使用 Bearer Token 认证：

```http
Authorization: Bearer <token>
```

Token 通过环境变量 `API_TOKEN` 配置（放入 `configs/secrets/.env`）。如果未配置，API 不需要认证（仅用于开发环境）。
