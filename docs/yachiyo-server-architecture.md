# Yachiyo Server Architecture

## 1. 目标

Yachiyo 后端不是传统的 chat API，也不是一坨 tool-calling glue code。

它的职责是：

- 管理多个 `Thread`
- 维护 `Append-Only` 的 Context 日志
- 通过 `Hook / Plugin` 机制扩展能力
- 用 `Harness` 作为结构化执行单元
- 通过 `AI SDK` 驱动模型运行时
- 通过 `WebSocket` 向前端持续推送事件

一句话：

> Yachiyo Server 是一个以 `Thread` 为主容器、以 `Append-Only Context` 为底座、以 `Hook / Plugin` 为扩展机制、以 `Harness` 为执行单元的本地运行时。

## 2. 顶层结构

```text
Local Yachiyo Server
  ├─ Gateway Layer
  │   ├─ WebSocket Gateway
  │   └─ HTTP Bootstrap API
  ├─ Application Layer
  │   ├─ Thread Service
  │   ├─ Run Service
  │   ├─ Context Service
  │   ├─ Hook Manager
  │   ├─ Plugin Registry
  │   └─ Harness Service
  ├─ Runtime Layer
  │   ├─ Orchestrator
  │   ├─ Model Runtime (AI SDK)
  │   └─ Event Emitter
  └─ Persistence Layer
      ├─ SQLite
      ├─ Repositories
      └─ Projection Builders
```

## 3. 核心设计原则

### 3.1 多 Thread 是默认前提

后端默认就是多 `Thread` 系统，不存在“单 chat + 历史列表补丁”的实现思路。

每个 `Thread` 都应该拥有：

- 自己的 message timeline
- 自己的 run history
- 自己的 append-only context log
- 自己的 harness invocation history
- 自己的 plugin injection history

### 3.2 Context 必须 Append-Only

Context 不能建模成“每次拼一坨 prompt 字符串”的临时变量。

更合理的建模是：

- `Thread` 下维护一个 `ContextEntry` 日志流
- 所有影响本次认知状态的输入都 append 到这里
- `Run` 启动时读取某个时间点的 context projection
- `Run` 完成后，把结果继续 append 回 context

可 append 的内容至少包括：

- user message
- assistant message
- system append
- harness result
- plugin injection
- thread summary

### 3.3 Memory 当前不是独立系统

当前阶段不实现独立的 `Memory Runtime` 或 `Memory Store`。

和 memory 相关的能力先走两条路径：

- 作为 hook，在 `message prepare`、`response complete` 等阶段介入
- 作为 plugin capability，被 harness 或模型调用路径按需注入

所以这里的重点不是“做 memory 子系统”，而是：

- 做稳定的 hook 生命周期
- 做清晰的 plugin registry
- 允许某个 plugin 提供 `memory search` 能力并注入到 run 里

### 3.4 Harness 不是 Tool

Harness 是结构化执行单元，不是简单函数调用。

一个 Harness 至少包含：

- schema
- context selection policy
- execution policy
- model usage policy
- output schema
- append policy
- allowed plugins

所以后端不应该围绕 `tool.execute()` 设计，而应该围绕 `harness.run()` 设计。

## 4. 领域对象

### `Thread`

主容器。

建议字段：

- `id`
- `title`
- `createdAt`
- `updatedAt`
- `archivedAt`
- `workspaceId`

### `Run`

一次执行过程。

建议字段：

- `id`
- `threadId`
- `triggerMessageId`
- `status`
- `startedAt`
- `endedAt`
- `contextHead`
- `provider`
- `model`
- `error`

这里的 `contextHead` 表示该次 run 启动时看到的 context log 位置。

### `ContextEntry`

Append-Only Context 的基础单元。

建议字段：

- `id`
- `threadId`
- `kind`
- `payload`
- `createdAt`
- `runId`
- `messageId`
- `harnessInvocationId`
- `pluginInvocationId`

推荐 `kind`：

- `user_message`
- `assistant_message`
- `plugin_injection`
- `harness_result`
- `system_append`
- `thread_summary`

### `Harness`

建议字段：

- `id`
- `name`
- `version`
- `inputSchema`
- `outputSchema`
- `contextPolicy`
- `appendPolicy`
- `allowedPlugins`

### `HarnessInvocation`

建议字段：

- `id`
- `threadId`
- `runId`
- `harnessId`
- `status`
- `input`
- `output`
- `startedAt`
- `endedAt`

### `Plugin`

建议字段：

- `id`
- `name`
- `version`
- `capabilities`
- `enabled`

### `PluginInvocation`

建议字段：

- `id`
- `threadId`
- `runId`
- `pluginId`
- `hook`
- `status`
- `input`
- `output`
- `startedAt`
- `endedAt`

## 5. 后端模块划分

### 5.1 Gateway Layer

#### `WebSocket Gateway`

职责：

- 接收前端事件
- 维持连接状态
- 向前端推送 run / harness / plugin 事件
- 做最薄的一层 schema 校验

推荐 package：

- `ws`
- `zod`

#### `HTTP Bootstrap API`

职责：

- 提供 `health`
- 提供 `bootstrap`
- 提供 thread list / message list 等冷启动数据

MVP 里只要少量接口，不用做成大 REST 系统。

### 5.2 Application Layer

#### `Thread Service`

职责：

- create / rename / archive thread
- 获取 thread timeline
- 获取 thread metadata

#### `Run Service`

职责：

- 创建 run
- 状态流转
- cancel run
- 持久化 run lifecycle

#### `Context Service`

职责：

- append context entry
- 按规则 materialize 当前 context view
- 管理 summary append

这是最核心的服务之一。

#### `Hook Manager`

职责：

- 注册生命周期 hook
- 按顺序执行 hook
- 统一 hook 输入输出格式
- 管理 hook 失败策略

建议第一版先支持这些 hook：

- `message.prepare`
- `context.materialize`
- `response.complete`
- `run.complete`
- `harness.before`
- `harness.after`

#### `Plugin Registry`

职责：

- 注册 plugin
- 暴露 plugin capabilities
- 控制某个 harness 可使用哪些 plugin
- 记录 plugin invocation

#### `Harness Service`

职责：

- 注册 harness
- 解析 harness policy
- 执行 harness invocation
- 把结果写回 context

### 5.3 Runtime Layer

#### `Orchestrator`

职责：

- 接收一次 run 请求
- 根据 thread 与 context head 构建执行视图
- 跑 `message.prepare` / `context.materialize` hook
- 决定直接模型回复还是走 harness
- 统一发出过程事件

推荐最小流程：

```text
chat.send
  -> create run
  -> append user_message
  -> run message.prepare hooks
  -> materialize context
  -> run context.materialize hooks
  -> choose direct reply or harness
  -> inject allowed plugin capabilities
  -> stream output
  -> append assistant_message / harness_result / plugin_injection
  -> run response.complete hooks
  -> complete run
```

#### `Model Runtime`

职责：

- 封装 `AI SDK`
- 统一 provider 配置
- 提供流式文本输出
- 后续承接 structured output

推荐 package：

- `ai`
- `@ai-sdk/openai`
- `@ai-sdk/anthropic`

#### `Event Emitter`

职责：

- 将内部状态变化统一转成前端事件
- 保证 run / harness / plugin 事件格式稳定

### 5.4 Persistence Layer

推荐：

- `better-sqlite3`
- `drizzle-orm`

建议分成三层：

- `schema`
- `repositories`
- `projections`

其中 `projections` 很重要，因为 append-only context 适合日志存储，但前端和运行时常常需要投影视图。

## 6. Context Materialization

这是 Yachiyo 后端和普通 chat backend 最不一样的地方。

建议把 Context 分成两层：

- `context log`: 永久 append-only
- `context view`: 针对某次 run 临时构造的投影

`context view` 的构造来源：

- 最近的用户消息
- 最近的 assistant 关键信息
- thread summary
- plugin 注入的上下文片段
- harness-specific append entries
- 必要的 system policy

这样做的好处：

- 保留完整演化轨迹
- 每次 run 都可复现上下文来源
- 不用把所有历史粗暴拼进 prompt

## 7. Hook / Plugin 架构

第一阶段建议把“增强能力”都挂到 hook / plugin 上，而不是拆出独立 runtime。

### Hook

Hook 是生命周期切点。

推荐第一版先固定这些名字：

- `message.prepare`
- `context.materialize`
- `before.model`
- `response.delta`
- `response.complete`
- `run.complete`

### Plugin

Plugin 是可注册的能力单元。

它可以：

- 订阅某个 hook
- 往 context 注入片段
- 暴露 callable capability 给 harness 或模型路径
- 记录自己的 invocation

### Memory Search Plugin

当前和 memory 相关的最合适形态，是做成一个 `memory search plugin`。

它可以通过两种方式介入：

- 在 `message.prepare` 阶段自动检索，并将结果转成 `plugin_injection`
- 作为一个 injected capability，在本次 run 中按需被 harness 或模型调用

这样你可以先获得“记忆检索”的体验，但不会过早引入完整 memory system。

## 8. Harness 架构

Harness 至少分两类：

### `Direct Reply Harness`

最基础的默认 harness。

职责：

- 选取上下文
- 调用模型
- 输出 assistant message
- 按 policy append 回 context

### `Structured Task Harness`

后续用于：

- repo analysis
- code planning
- delegation
- plugin-assisted workflows

它和 direct reply 的区别不是“有没有调工具”，而是：

- 它有更严格的 context policy
- 它有更明确的 output schema
- 它会声明允许哪些 plugin capabilities

## 9. 推荐目录结构

```text
src/server/
  index.ts
  gateway/
    ws.ts
    http.ts
    schemas.ts
  application/
    thread-service.ts
    run-service.ts
    context-service.ts
    hook-manager.ts
    plugin-registry.ts
    harness-service.ts
  runtime/
    orchestrator.ts
    model-runtime.ts
    event-emitter.ts
  domain/
    thread.ts
    run.ts
    context-entry.ts
    harness.ts
    harness-invocation.ts
    plugin.ts
    plugin-invocation.ts
  storage/
    db.ts
    schema.ts
    repositories/
    projections/
  shared/
    ids.ts
    time.ts
    logger.ts
```

## 10. MVP 取舍

第一阶段先不做：

- 多 agent graph
- 复杂并发 harness 调度
- 远程分布式 server
- 独立 memory runtime / memory store
- 大而全插件系统

第一阶段先做：

- 多 Thread
- append-only context log
- run lifecycle
- AI SDK 流式输出
- hook manager 基础闭环
- plugin registry 和一个 `memory search plugin` 注入样例
- harness registry 和一个默认 direct reply harness

## 11. 推荐 package

```text
ws
zod
ai
@ai-sdk/openai
@ai-sdk/anthropic
better-sqlite3
drizzle-orm
pino
nanoid
date-fns
```

补充说明：

- `ws`: WebSocket gateway
- `zod`: event / harness / plugin schema 校验
- `ai`: 模型流式运行时
- `better-sqlite3 + drizzle-orm`: 本地持久化
- `pino`: 结构化日志

## 12. 结论

Yachiyo 后端当前阶段的关键不是“把 memory system 先做出来”，而是把这 4 个东西钉死：

- `Thread` 是主容器
- `Context` 必须 append-only
- `Hook / Plugin` 是增强机制
- `Harness` 是执行单元

这四个点定住之后，前端 mock 往后接真实 runtime 时，就不会退化成一个普通 chat app backend。
