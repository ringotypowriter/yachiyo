# Yachiyo Event Protocol（第一版）

## 1. 目标

这份文档定义 Yachiyo 第一阶段的实时通信协议。

设计目标：

- 以前后端 `WebSocket` 长连接作为主通道
- 以 `event-based` 而不是 request-response 作为协议范式
- 支持流式消息输出
- 支持 run 生命周期管理
- 为 harness activity、plugin injection、delegation 预留扩展位

一句话：

> 一条用户消息，驱动的是一次 `run`，前端接收的是这个 `run` 过程中不断产生的事件。

## 2. 连接模型

推荐连接地址：

- `ws://127.0.0.1:<port>/realtime`

可选 HTTP 配套接口：

- `GET /health`
- `GET /bootstrap`

连接建立后：

- 前端维护单个主 WebSocket 连接
- 所有 chat、run、harness、plugin 相关实时事件都走这条连接
- 历史数据读取和初始化信息可以走 HTTP

## 3. 协议原则

### 3.1 统一字段

所有事件建议至少包含以下字段：

- `type`
- `eventId`
- `timestamp`
- `threadId`
- `runId`（没有则可省略）

示例：

```json
{
  "type": "run.created",
  "eventId": "evt_001",
  "timestamp": "2026-03-14T12:10:00.000Z",
  "threadId": "thread_001",
  "runId": "run_001"
}
```

### 3.2 前端只消费事件，不猜状态

前端不要靠推断来决定 run 是否结束，而是以明确事件为准：

- `run.created`
- `message.started`
- `message.delta`
- `message.completed`
- `run.completed`
- `run.failed`
- `run.cancelled`

### 3.3 run 是一等公民

- 一个用户动作通常触发一个 `run`
- 一个 `run` 可以产生多个事件
- 一个 `run` 通常至少会产生一个 assistant message
- 后续一个 `run` 也可能包含 harness activity、plugin injection、delegate task 等过程

## 4. Client -> Server 事件

### `chat.send`

用途：发送用户消息，并触发一个新的 run。

```json
{
  "type": "chat.send",
  "threadId": "thread_001",
  "message": {
    "role": "user",
    "content": "帮我看看这个项目结构"
  },
  "meta": {
    "workspaceId": "workspace_default",
    "attachments": []
  }
}
```

### `run.cancel`

用途：取消当前执行。

```json
{
  "type": "run.cancel",
  "threadId": "thread_001",
  "runId": "run_001"
}
```

### `thread.create`

用途：新建线程。

```json
{
  "type": "thread.create",
  "title": "新的对话"
}
```

### `thread.rename`

```json
{
  "type": "thread.rename",
  "threadId": "thread_001",
  "title": "Yachiyo 架构讨论"
}
```

### `thread.archive`

```json
{
  "type": "thread.archive",
  "threadId": "thread_001"
}
```

## 5. Server -> Client 事件

### 5.1 Thread 相关

#### `thread.created`

```json
{
  "type": "thread.created",
  "eventId": "evt_002",
  "timestamp": "2026-03-14T12:11:00.000Z",
  "thread": {
    "id": "thread_002",
    "title": "新的对话",
    "createdAt": "2026-03-14T12:11:00.000Z",
    "updatedAt": "2026-03-14T12:11:00.000Z"
  }
}
```

### 5.2 Run 生命周期

#### `run.created`

```json
{
  "type": "run.created",
  "eventId": "evt_101",
  "timestamp": "2026-03-14T12:12:00.000Z",
  "threadId": "thread_001",
  "runId": "run_001",
  "status": "running",
  "triggerMessageId": "msg_user_001",
  "model": "claude-sonnet-4",
  "provider": "anthropic"
}
```

#### `run.completed`

```json
{
  "type": "run.completed",
  "eventId": "evt_110",
  "timestamp": "2026-03-14T12:12:08.000Z",
  "threadId": "thread_001",
  "runId": "run_001",
  "status": "completed",
  "messageId": "msg_asst_001"
}
```

#### `run.failed`

```json
{
  "type": "run.failed",
  "eventId": "evt_111",
  "timestamp": "2026-03-14T12:12:08.000Z",
  "threadId": "thread_001",
  "runId": "run_001",
  "status": "failed",
  "error": {
    "code": "PROVIDER_TIMEOUT",
    "message": "provider timeout"
  }
}
```

#### `run.cancelled`

```json
{
  "type": "run.cancelled",
  "eventId": "evt_112",
  "timestamp": "2026-03-14T12:12:05.000Z",
  "threadId": "thread_001",
  "runId": "run_001",
  "status": "cancelled"
}
```

### 5.3 Message 相关

#### `message.started`

```json
{
  "type": "message.started",
  "eventId": "evt_120",
  "timestamp": "2026-03-14T12:12:01.000Z",
  "threadId": "thread_001",
  "runId": "run_001",
  "messageId": "msg_asst_001",
  "role": "assistant"
}
```

#### `message.delta`

```json
{
  "type": "message.delta",
  "eventId": "evt_121",
  "timestamp": "2026-03-14T12:12:01.200Z",
  "threadId": "thread_001",
  "runId": "run_001",
  "messageId": "msg_asst_001",
  "text": "我先看看这个项目结构。"
}
```

#### `message.completed`

```json
{
  "type": "message.completed",
  "eventId": "evt_122",
  "timestamp": "2026-03-14T12:12:08.000Z",
  "threadId": "thread_001",
  "runId": "run_001",
  "messageId": "msg_asst_001"
}
```

### 5.4 Harness 相关事件

#### `harness.started`

```json
{
  "type": "harness.started",
  "eventId": "evt_201",
  "timestamp": "2026-03-14T12:12:02.000Z",
  "threadId": "thread_001",
  "runId": "run_001",
  "harnessInvocationId": "h_001",
  "harnessName": "direct-reply"
}
```

#### `harness.finished`

```json
{
  "type": "harness.finished",
  "eventId": "evt_202",
  "timestamp": "2026-03-14T12:12:07.000Z",
  "threadId": "thread_001",
  "runId": "run_001",
  "harnessInvocationId": "h_001",
  "harnessName": "direct-reply",
  "status": "completed"
}
```

### 5.5 Plugin 相关事件

#### `plugin.injected`

```json
{
  "type": "plugin.injected",
  "eventId": "evt_301",
  "timestamp": "2026-03-14T12:12:01.500Z",
  "threadId": "thread_001",
  "runId": "run_001",
  "pluginInvocationId": "p_001",
  "pluginName": "memory-search",
  "hook": "message.prepare"
}
```

#### `plugin.failed`

```json
{
  "type": "plugin.failed",
  "eventId": "evt_302",
  "timestamp": "2026-03-14T12:12:01.700Z",
  "threadId": "thread_001",
  "runId": "run_001",
  "pluginInvocationId": "p_001",
  "pluginName": "memory-search",
  "hook": "message.prepare",
  "error": {
    "code": "PLUGIN_ERROR",
    "message": "search backend unavailable"
  }
}
```

## 6. 推荐事件顺序

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

## 7. 当前取舍

第一阶段先不做：

- 多路并发 run
- 二进制附件传输
- 复杂 ack / replay 机制
- 远端 server 多端同步

第一阶段先做：

- 单连接
- 单线程内单活跃 run
- 文本流式输出
- run 可取消
- harness event 扩展位
- plugin injection event 扩展位

## 8. 结论

Yachiyo 协议第一阶段的重点是：

- 以 `run` 为中心，不以单条 message 为中心
- 以 `event stream` 为中心，不以接口返回值为中心
- 先把最小状态机打稳，再扩充 harness / plugin / delegation 事件
