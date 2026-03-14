# Yachiyo Event Protocol

## 目标

Yachiyo 第一阶段的前后端通信采用 `event-based` 协议，主通道是 `WebSocket`。

这份文档只定义稳定契约，不提前写死过细实现。

一句话：

> 一条用户消息，驱动的是一次 `run`，前端接收的是这个 `run` 过程中不断产生的事件。

## 协议原则

### 事件优先

前后端通信以事件流为核心，而不是请求-响应思维。

### run 是一等公民

用户动作触发的是一次 `run`，而不是只生成一条静态 assistant message。

### 前端只消费明确事件

前端不要猜状态，而是根据明确事件切换 UI。

### 扩展位先留好

协议从第一天就要允许未来加入：

- harness activity
- plugin injection
- delegation

## 基础字段

所有事件至少应包含：

- `type`
- `eventId`
- `timestamp`
- `threadId`
- `runId`（如适用）

## 核心事件类型

### Client -> Server

- `chat.send`
- `run.cancel`
- `thread.create`
- `thread.rename`
- `thread.archive`

### Server -> Client

- `thread.created`
- `run.created`
- `run.completed`
- `run.failed`
- `run.cancelled`
- `message.started`
- `message.delta`
- `message.completed`
- `harness.started`
- `harness.finished`
- `plugin.injected`
- `plugin.failed`

## 推荐事件顺序

最小 direct reply 流程：

```text
chat.send
-> run.created
-> plugin.injected (optional)
-> harness.started
-> message.started
-> message.delta ...
-> message.completed
-> harness.finished
-> run.completed
```

取消流程：

```text
chat.send
-> run.created
-> message.started
-> run.cancel
-> run.cancelled
```

## 当前约束

第一阶段重点是把最小状态机打稳。

所以这份协议当前只强调：

- 事件类别
- 生命周期顺序
- 前端可依赖的状态切换点

而不提前绑定：

- 过细 payload 字段
- 复杂 ack / replay 机制
- 多端同步细节
- 二进制附件协议
