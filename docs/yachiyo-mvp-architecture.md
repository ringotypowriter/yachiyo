# Yachiyo MVP 架构设计（第一版）

## 1. 目标

Yachiyo 当前不是要一次性做成完整的通用 Agent 平台，而是先做一个可用、可扩展、前端体验清晰的 AI Chat 产品壳。

第一阶段目标：

- 提供一个稳定的桌面端 AI Chat 界面
- 支持流式输出
- 支持前后端 persistent connection
- 为后续的 hook、plugin、harness orchestration 预留扩展位
- 后端先保持轻量，不急着做复杂自治系统

一句话定义当前阶段：

> 先做 `Chat-first, Agent-ready` 的 Yachiyo。

## 2. 产品定位

Yachiyo 是一个桌面端的 AI Chat / Agent Shell。

它的第一阶段形态应该是：

- 表面上是一个体验好的聊天客户端
- 内部上是一个有状态的本地服务系统
- 协议层从一开始就按事件流来设计
- 后续可以逐步注入 harness、plugin、coding agent、project context

所以不要把它理解成：

- 先做一个很重的 Agent Core，再去补 UI

而应该理解成：

- 先把聊天体验、状态模型、实时通信、扩展骨架搭起来
- 再把 Agent 能力一层层塞进去

## 3. 顶层架构

推荐采用以下结构：

```text
Electron App
  ├─ Renderer (React UI)
  ├─ Main Process (App lifecycle + process manager)
  └─ Local Yachiyo Server
       ├─ WebSocket Gateway
       ├─ Chat Orchestrator
       ├─ Model Runtime
       ├─ Harness Runtime
       ├─ Hook / Plugin Runtime
       └─ Storage Layer
```

### 3.1 为什么是 Local Server

Agent 本体做成一个 server 形态的服务，比把所有逻辑直接糊进 Electron renderer 更稳。

原因：

- 职责分离更清楚，UI 和运行时解耦
- 更适合 persistent connection
- 更适合事件流与流式输出
- 后续可以单独调试、单测、替换运行时
- 后面支持多窗口、多客户端、插件式能力也更自然

### 3.2 为什么是 WebSocket

MVP 阶段推荐前后端主通道直接用 WebSocket。

因为 Yachiyo 不是传统 CRUD App，而是一个会持续推送状态的系统：

- token streaming
- run status
- harness started / harness finished
- plugin injection
- subtask progress
- cancel / retry

这些都非常适合事件流模型，WebSocket 比 request-response 的 HTTP 更自然。

## 4. 进程与职责边界

### 4.1 Renderer（React 前端）

职责：

- 展示线程列表
- 展示消息列表
- 展示流式输出中的 assistant message
- 展示 harness activity / run status / error
- 负责输入框、快捷操作、页面交互
- 通过 WebSocket 与本地 server 保持长连接

不要让 renderer 直接承担：

- 模型调用
- harness 执行
- hook / plugin 编排
- 复杂状态机

Renderer 应该尽量保持为界面层加轻状态层。

### 4.2 Main Process（Electron 主进程）

职责：

- 应用生命周期管理
- 窗口管理
- 启动 / 停止本地 Yachiyo Server
- 给 renderer 提供 server 地址、环境信息、少量安全 IPC
- 后续如果需要，也可以代理系统级能力

### 4.3 Local Yachiyo Server

这是第一阶段最核心的运行时。

职责：

- 接受来自前端的 chat 请求
- 维护 thread / run 生命周期
- 调用模型并产出流式事件
- 调用 harness 并返回过程事件
- 运行 hook / plugin 注入逻辑
- 持久化 thread、message、run、event

推荐模式：

- WebSocket 负责实时主通道
- 少量 HTTP endpoint 负责健康检查和初始化信息

## 5. 最小可行功能闭环

第一版不要做复杂 agent 自治，只需要跑通下面这条链路：

1. 用户在前端输入一条消息
2. 前端通过 WebSocket 发出 `chat.send`
3. server 创建一个 `run`
4. orchestrator 组装上下文并调用模型或 harness
5. 流式输出通过 WebSocket 持续推回前端
6. run 结束后写入 message / run / event
7. 前端把完整消息和状态展示出来

这就已经是一个真正可用的第一版 Yachiyo。

## 6. 推荐的事件流协议

不要把协议设计成简单的发消息 / 收消息，而是统一成 event-based。

### 前端发给服务端

```json
{
  "type": "chat.send",
  "threadId": "thread_001",
  "message": {
    "role": "user",
    "content": "帮我看看这个项目结构"
  }
}
```

### 服务端推给前端

```json
{ "type": "run.created", "runId": "run_001", "threadId": "thread_001" }
{ "type": "plugin.injected", "runId": "run_001", "pluginName": "memory-search" }
{ "type": "harness.started", "runId": "run_001", "harnessName": "direct-reply" }
{ "type": "message.delta", "runId": "run_001", "text": "我先看看" }
{ "type": "message.completed", "runId": "run_001", "messageId": "msg_002" }
{ "type": "harness.finished", "runId": "run_001", "harnessName": "direct-reply" }
{ "type": "run.completed", "runId": "run_001" }
```

这样设计的价值是：

- 前端状态模型非常清楚
- 后续加入 harness / plugin 时不用改协议范式
- 多 agent、任务树、观察面板都能平滑演进

## 7. 领域模型

Yachiyo 第一阶段建议先固定这几个核心对象。

### `Thread`

表示一个会话。

建议字段：

- `id`
- `title`
- `createdAt`
- `updatedAt`
- `workspaceId`（可选）
- `archivedAt`（可选）

### `Message`

表示最终落库的用户消息或助手消息。

建议字段：

- `id`
- `threadId`
- `role` (`user` | `assistant` | `system`)
- `content`
- `status` (`streaming` | `completed` | `failed`)
- `createdAt`
- `runId`

### `Run`

一条用户消息不一定只对应一条简单回复，而是对应一次执行过程，所以要把 run 作为一等公民。

建议字段：

- `id`
- `threadId`
- `triggerMessageId`
- `status` (`queued` | `running` | `completed` | `failed` | `cancelled`)
- `startedAt`
- `endedAt`
- `model`
- `provider`
- `error`

### `ContextEntry`

Append-Only 上下文的基础单元。

建议字段：

- `id`
- `threadId`
- `kind`
- `payload`
- `createdAt`
- `runId`
- `messageId`

### `HarnessInvocation`

表示一次 harness 执行过程。

建议字段：

- `id`
- `threadId`
- `runId`
- `harnessName`
- `status`
- `input`
- `output`
- `startedAt`
- `endedAt`

### `PluginInvocation`

表示一次 plugin 注入或调用。

建议字段：

- `id`
- `threadId`
- `runId`
- `pluginName`
- `hook`
- `status`
- `input`
- `output`
- `startedAt`
- `endedAt`

## 8. 技术实现建议

### 8.1 桌面壳

当前仓库已经是：

- Electron
- React
- TypeScript
- electron-vite

这个基础没问题，不需要推翻。

### 8.2 前端状态与数据层

推荐：

- `zustand`
- `@tanstack/react-query`

推荐分工：

- `zustand`：实时 UI 状态
- `react-query`：服务端持久数据缓存

### 8.3 路由

如果要上：

- `react-router-dom`

但 MVP 里其实一个主页面加侧边栏加 thread 切换就够了，不急。

### 8.4 Markdown 渲染

推荐组合：

- `streamdown`
- `shiki`
- `rehype-sanitize`

推荐结论：

- 第一版直接采用 `streamdown + shiki + rehype-sanitize`

### 8.5 WebSocket 通信

推荐包：

- `ws`

用途：

- 服务端 WebSocket Server
- 桌面端本地实时事件推送

### 8.6 Agent / Model Core

Yachiyo 当前阶段不建议一上来引入 LangChain / LangGraph 这类较重框架做主骨架。

推荐：

- `ai`
- `@ai-sdk/openai`
- `@ai-sdk/anthropic`
- `zod`

实现原则：

- 核心编排自己写
- 模型流式能力交给 `ai`
- schema 校验交给 `zod`
- 执行单元围绕 `harness`
- 可插拔增强围绕 `hook / plugin`

### 8.7 数据库存储

推荐：

- `better-sqlite3`
- `drizzle-orm`

第一阶段落库对象：

- threads
- messages
- runs
- context_entries
- harness_invocations
- plugin_invocations

### 8.8 日志与错误监控

推荐：

- `pino`

### 8.9 ID、时间、工具函数

推荐：

- `nanoid`
- `date-fns`

## 9. 推荐 package 清单

### 前端

```text
zustand
@tanstack/react-query
streamdown
rehype-sanitize
shiki
react-router-dom
```

### 服务端 / Runtime

```text
ws
ai
@ai-sdk/openai
@ai-sdk/anthropic
zod
better-sqlite3
drizzle-orm
nanoid
pino
date-fns
```

### 暂时不急着引入

```text
langchain
langgraph
socket.io
redux
postgresql client
```

## 10. 推荐目录结构

```text
src/
  main/
    index.ts
    process/
      server-manager.ts
    ipc/
      app.ts

  preload/
    index.ts

  renderer/
    src/
      app/
        routes/
        providers/
        store/
      features/
        threads/
        chat/
        composer/
        runs/
        harness/
      components/
      lib/
        markdown/
        websocket/
        format/
      styles/
      App.tsx
      main.tsx

  server/
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
    storage/
      db.ts
      schema.ts
      repositories/
      projections/
    shared/
      ids.ts
      logger.ts
      types.ts
```

## 11. 第一阶段前端页面建议

MVP 前端不要做太多页，先把主工作台打磨出来。

建议只做一个主界面，内部拆成 4 个区域：

- 左侧：`Thread Sidebar`
- 中间：`Message Timeline`
- 底部：`Composer`
- 顶部或底部细条：`Run Status Bar`

后续可插入：

- `Harness Activity Card`
- `Plugin Injection Badge`
- `Model Badge`
- `Connection Status`

## 12. 第一阶段实现顺序

### Milestone 1：Chat Shell

目标：

- 本地窗口跑起来
- 聊天界面完成
- 支持 thread 列表和 message 列表
- 支持 markdown message 渲染

### Milestone 2：Realtime Runtime

目标：

- 本地 server 可启动
- renderer 能连上 ws
- 支持 `chat.send`
- 支持 `message.delta`
- 支持 `run.completed`

### Milestone 3：Persistence

目标：

- thread / message / run / context_entries 落 SQLite
- 重启应用后能恢复历史会话

### Milestone 4：Agent-ready 扩展位

目标：

- event 协议中加入 harness / plugin events
- server 内部加入 hook manager 和 plugin registry
- 为 `memory search plugin` 预留注入点

## 13. 当前阶段的明确取舍

Yachiyo 第一阶段明确不做：

- 复杂多 Agent graph
- 大规模插件系统
- 独立 memory system
- 通用 workflow automation
- 昂贵的 coding agent 默认深度集成

Yachiyo 第一阶段明确要做：

- 好用的 chat 前端
- 清晰的事件流协议
- 可维护的 server 运行时
- 本地持久化
- 为未来 Harness / Plugin 能力预留结构

## 14. 推荐结论

如果现在要拍板，我建议的第一阶段技术选型是：

### 前端

- Electron
- React
- TypeScript
- `zustand`
- `@tanstack/react-query`
- `streamdown`
- `rehype-sanitize`
- `shiki`

### 服务端

- `ws`
- `ai`
- `@ai-sdk/openai`
- `@ai-sdk/anthropic`
- `zod`
- `better-sqlite3`
- `drizzle-orm`
- `pino`
- `nanoid`
- `date-fns`

### 架构关键词

- Electron Shell
- Local Server
- WebSocket Event Stream
- Run-based State Model
- Append-Only Context
- Harness Runtime
- Hook / Plugin Extension

## 15. 下一步文档

在这份文档之后，最适合继续写的文档是：

1. `docs/yachiyo-event-protocol.md`
2. `docs/yachiyo-ui-architecture.md`
3. `docs/yachiyo-server-architecture.md`
