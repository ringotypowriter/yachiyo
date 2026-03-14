# Yachiyo Grounding

这份文档是当前阶段给实现 agent 的最小 grounding。

如果更长的架构文档与这份文档有冲突，以这份为准。

## 当前目标

Yachiyo 现在先做一个本地桌面 AI Chat。

重点不是复杂自治，而是把下面这条链路跑通：

```text
Thread -> Message -> Run -> streaming response -> persist result
```

## 当前不变量

- 系统默认支持多个 `Thread`
- `Thread` 是会话主容器
- 后端 `Context` 必须是 `Append-Only`
- 执行单元叫 `Harness`，不是 `Tool`
- memory 当前不做独立系统
- memory 相关能力先走 `Hook / Plugin`，例如 `memory search plugin`
- 当前桌面壳里，前后端主通道是 Electron IPC Event Bridge；协议形态仍然保持 event-based
- 模型运行时用 `AI SDK`

## 当前传输层现实

当前实现已经采用：

- Renderer 通过 `preload` 暴露的 `window.api.yachiyo.*` 调用后端
- Main Process 通过 `ipcMain.handle` / `webContents.send` 充当 gateway
- 本地运行时仍然是 `YachiyoServer`
- 事件模型保持不变，只是承载通道当前不是 WebSocket，而是 Electron IPC

所以对实现 agent 来说，当前应该优先对齐：

- `event-based` 生命周期
- Electron IPC gateway
- 本地 `YachiyoServer`

而不是强行把传输层理解成浏览器里的裸 WebSocket。

## 前端已经默认依赖的对象

### `Thread`

前端当前至少需要：

- `id`
- `title`
- `updatedAt`
- `preview?`

### `Message`

前端当前至少需要：

- `id`
- `threadId`
- `role`
- `content`
- `status`

其中：

- `role` 目前至少有 `user | assistant`
- `status` 目前至少有 `completed | streaming | failed`

### `Run UI State`

前端当前至少依赖：

- `idle`
- `running`
- `completed`
- `failed`

### `Connection UI State`

前端当前至少依赖：

- `connected`
- `connecting`
- `disconnected`

## 前端已经默认依赖的事件

最小必须保留：

- `thread.created`
- `run.created`
- `message.started`
- `message.delta`
- `message.completed`
- `run.completed`
- `run.failed`
- `run.cancelled`

可扩展但建议保留命名空间：

- `harness.started`
- `harness.finished`
- `plugin.injected`
- `plugin.failed`

## 当前前端渲染模型

前端当前的消息时间线是：

- 先显示历史消息
- assistant streaming 时显示一条进行中的 assistant message
- run 结束后把 streaming message 视为 completed

所以后端接入时，最顺的事件顺序是：

```text
chat.send
-> run.created
-> message.started
-> message.delta ...
-> message.completed
-> run.completed
```

## 当前需要注意的语义偏差

前端 mock 里现在还保留了 `toolCalls` / `ToolCallCard` 这套展示模型。

这只是现阶段 UI mock 的遗留语义，不应反向决定后端架构。

后端仍应坚持：

- `Harness`
- `Hook / Plugin`
- `memory search plugin`

如果需要兼容当前前端，可以在接入层做 adapter，把后端活动投影成前端可显示的 activity 数据。

## 当前实现优先级

现阶段 agent 最应该对齐的是：

- 多 `Thread`
- `Run` 驱动的流式消息
- `Append-Only Context`
- 默认 reply harness
- 基础 `Hook / Plugin` 扩展位

现阶段不用优先对齐的是：

- 独立 memory system
- 复杂数据库设计
- 过细目录结构
- 复杂多 agent graph
