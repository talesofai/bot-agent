# 技术语言选型分析：Python vs TypeScript

## 背景

本项目需要选择主要开发语言。候选语言为 **Python** 和 **TypeScript**。

## 关键考量因素

### 1. 生态系统兼容性

| 组件                | Python 支持             | TypeScript 支持              |
| ------------------- | ----------------------- | ---------------------------- |
| LuckyLilliaBot      | 通过 API 调用           | ✅ 原生（TS 项目）           |
| Milky SDK           | ✅ `milky-python-sdk`   | ✅ `@saltify/milky-node-sdk` |
| opencode            | 通过 CLI 调用           | ✅ 原生（TS 项目，可导入）   |
| Eridanus (参考实现) | ✅ **原生 Python 项目** | 需要重写                     |

### 2. 详细对比

| 维度           | Python                | TypeScript              |
| -------------- | --------------------- | ----------------------- |
| **开发速度**   | ⭐⭐⭐⭐⭐ 更快       | ⭐⭐⭐⭐ 较快           |
| **类型安全**   | ⭐⭐⭐ (需 mypy)      | ⭐⭐⭐⭐⭐ 原生支持     |
| **AI/ML 生态** | ⭐⭐⭐⭐⭐ 最强       | ⭐⭐⭐ 较弱             |
| **异步处理**   | ⭐⭐⭐ asyncio        | ⭐⭐⭐⭐⭐ 原生 Promise |
| **部署复杂度** | ⭐⭐⭐ 需管理虚拟环境 | ⭐⭐⭐⭐ Node 容器成熟  |
| **团队熟悉度** | 待确认                | 待确认                  |
| **与前端协作** | ⭐⭐                  | ⭐⭐⭐⭐⭐ 同语言       |

---

## Python 优势详解

### ✅ 1. Eridanus 参考实现是 Python

玲可之前的临时版本 [Eridanus](https://github.com/AOrbitron/Eridanus) 是 **Python** 项目：

- 可以直接参考其 function calling 逻辑
- 可以复用其部分代码和经验
- 减少重写成本

### ✅ 2. AI/ML 生态最强

- **LangChain** / **LlamaIndex**：成熟的 Agent 框架
- **直接调用本地模型**：如果需要 vLLM、Ollama 等
- **Anthropic/OpenAI SDK**：Python 版本通常是官方首发

### ✅ 3. milky-python-sdk 存在

```python
from milky_sdk import MilkyClient

client = MilkyClient("ws://localhost:3000")
client.on_message(handle_message)
await client.connect()
```

### ✅ 4. 快速原型开发

Python 语法简洁，适合快速迭代验证想法。

### ✅ 5. 数据处理能力

如果后续需要做数据分析、训练微调等，Python 生态显著优于 TS。

---

## TypeScript 优势详解

### ✅ 1. 与核心组件原生兼容

- **LuckyLilliaBot**：TypeScript 项目
- **opencode**：TypeScript 项目（83.7%）
- 可以直接导入模块，而不是通过 CLI/API 调用

### ✅ 2. 类型安全

编译时捕获错误，重构更安全。

### ✅ 3. 异步处理更自然

```typescript
// TypeScript async/await 更自然
const msg = await client.getMessage();
await agent.process(msg);
```

### ✅ 4. 与前端统一

如果后续需要 WebUI，可以共享代码（如类型定义）。

### ✅ 5. Discord.js 生态

春节后要做 Discord Bot，`discord.js` 是 TS 生态成熟的选择。

---

## 分析结论

### 场景 A：快速验证 + AI 能力扩展 → **推荐 Python**

如果项目目标是：

- 快速复刻 Eridanus 的能力
- 后续可能接入本地模型、做微调
- 优先验证玩法，再优化工程

### 场景 B：长期维护 + 多平台扩展 → **推荐 TypeScript**

如果项目目标是：

- 作为正式产品长期维护
- 需要深度集成 opencode 能力
- 多平台（QQ + Discord）统一代码库

---

## 我的建议

**推荐：Python**

理由：

1. **Eridanus 是 Python**，可以直接参考和复用经验
2. **AI Agent 场景**，Python 生态（LangChain、function calling）更成熟
3. **快速验证**，先在 K8s 跑起来验证稳定性才是第一步
4. **Milky Python SDK 存在**，不用造轮子
5. 后续 Discord 可以再评估是否用 TS 单独写 adapter

### 折中方案

如果担心 Python 类型不安全，可以使用：

- **Pydantic**：数据模型验证
- **mypy**：静态类型检查
- **ruff**：快速 linter

---

## 待用户确认

1. **团队技术栈偏好**：团队更熟悉 Python 还是 TypeScript？
2. **与 opencode 的集成深度**：是直接导入模块，还是通过 CLI 调用即可？
3. **本地模型需求**：是否需要接入 vLLM/Ollama 等本地模型？
4. **Discord 时间线**：Discord Bot 的优先级和时间节点？

---

## 文件清理建议

如果确定用 Python，需要删除已创建的 TypeScript 文件：

- `src/` 目录
- `package.json`
- `tsconfig.json`

---

## 最终决策

**日期**：2025-01-09

**决策**：使用 **TypeScript**

**理由**：

1. 需要一开始就考虑 Discord 支持，TypeScript 的 discord.js 生态成熟
2. 长期维护考虑，类型安全更重要
3. 与 opencode、LuckyLilliaBot 技术栈一致

**架构要求**：

- 设计多平台适配器抽象（Adapter 模式）
- QQ 和 Discord 共用核心 Agent 逻辑
- 先实现 QQ，预留 Discord 适配器位置
