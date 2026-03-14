# Yachiyo UI Architecture

## 1. 目标

Yachiyo 的前端第一阶段不是做复杂页面系统，而是做一个稳定、清晰、适合流式 AI Chat 的主工作台。

UI 设计目标：

- 聊天体验顺滑
- 流式输出状态清楚
- thread 切换自然
- 后续能插入 tool call、memory、agent 状态
- 前端状态结构不要和后端运行时耦太死

## 2. 页面结构

MVP 建议只做一个主页面，拆成 4 个核心区域：

```text
App Shell
  ├─ Sidebar
  │   └─ Thread List
  ├─ Chat Panel
  │   ├─ Header
  │   ├─ Message Timeline
  │   └─ Composer
  └─ Run Status Bar
```

### 2.1 Sidebar

职责：

- 展示 thread 列表
- 切换当前 thread
- 创建新 thread
- 后续可加入 search / pin / archive

### 2.2 Header

职责：

- 展示当前 thread 标题
- 展示连接状态
- 展示当前模型或 provider
- 后续可加入 workspace 信息

### 2.3 Message Timeline

职责：

- 展示历史 message
- 展示当前 streaming assistant message
- 展示失败状态
- 后续插入 tool event card

### 2.4 Composer

职责：

- 输入消息
- 发送消息
- run 进行中时支持 cancel
- 后续可加入 slash command 和附件

### 2.5 Run Status Bar

职责：

- 展示当前 run 是否执行中
- 展示连接状态
- 展示错误或重试提示

## 3. 组件分层建议

```text
app/
  providers/
  store/
features/
  threads/
  chat/
  composer/
  runs/
components/
  ui/
  markdown/
lib/
  websocket/
  format/
```

建议原则：

- `features` 放业务组件
- `components/ui` 放纯展示组件
- `lib` 放工具函数和基础适配层
- `store` 放全局状态

## 4. 核心组件建议

### `ThreadSidebar`

负责：

- thread 列表渲染
- 当前 thread 高亮
- new thread 按钮

### `ChatHeader`

负责：

- 标题
- connection badge
- model badge

### `MessageList`

负责：

- 渲染历史消息
- 渲染 streaming message
- 控制滚动到底部

### `MessageBubble`

负责：

- 根据 `role` 渲染 user / assistant / system
- assistant 消息走 markdown 渲染
- user 消息保持简洁纯文本样式

### `Composer`

负责：

- textarea
- submit
- cancel
- disabled 状态

### `RunStatusBar`

负责：

- 显示 `idle` / `running` / `failed`
- 显示最后一个错误

## 5. 前端状态分工

前端推荐把状态拆成两类：

- 持久数据状态
- 实时会话状态

### 5.1 `react-query`

负责：

- thread list
- 历史 messages
- 初始化拉取
- 缓存与失效管理

适合处理：

- `GET /threads`
- `GET /threads/:id/messages`
- `GET /bootstrap`

### 5.2 `zustand`

负责：

- 当前连接状态
- 当前活跃 run
- streaming message buffer
- composer 输入态
- 当前选中的 threadId

推荐 store 结构：

```ts
interface ChatUiState {
  activeThreadId: string | null
  connectionStatus: 'connecting' | 'ready' | 'closed'
  activeRunId: string | null
  runStatus: 'idle' | 'running' | 'completed' | 'failed' | 'cancelled'
  streamingText: string
  lastError: string | null
}
```

## 6. Streaming Message 的处理方式

这是 Yachiyo 前端最关键的一块。

不要把 `message.delta` 直接当正式 message 落进历史列表，而是建议：

- 历史消息来自 query 数据
- 当前流式消息单独存在 `streamingText`
- 收到 `message.completed` 后，再把正式消息并入列表或触发 query 更新

推荐流程：

1. 收到 `run.created`
2. `runStatus` -> `running`
3. 清空 `streamingText`
4. 每次收到 `message.delta` 就 append 到 `streamingText`
5. 收到 `message.completed` 后清空 buffer
6. 触发当前 thread message query 刷新，或者直接 optimistic merge

这样做的好处：

- 流式态和持久态分离
- UI 逻辑简单
- 失败和取消时更容易处理

## 7. Markdown 渲染层

你已经拍板：

- markdown 渲染用 `streamdown`
- 代码高亮用 `shiki`

所以前端建议单独封一个：

- `components/markdown/MarkdownMessage.tsx`

职责：

- 接收 assistant message content
- 走 `streamdown` 渲染
- 代码块统一交给 `shiki`
- 后续可统一处理 code block copy、diff block、command block

这样以后不管 message bubble 怎么改，markdown 渲染层都不用散落到别的组件里。

## 8. WebSocket 适配层

建议不要在 React 组件里直接写原始 ws 逻辑，而是包一层：

- `lib/websocket/client.ts`

职责：

- 建立连接
- 统一发送 event
- 分发服务端 event
- 管理 reconnect
- 向 zustand store 派发状态更新

推荐接口风格：

```ts
connect(): void
send(event): void
disconnect(): void
subscribe(type, handler): () => void
```

这样业务组件只关心：

- 我要发什么 event
- 我要订阅什么状态

## 9. 建议的 UI 数据流

```text
Composer submit
  -> websocket.send(chat.send)
  -> store.runStatus = running
  -> server emits run.created
  -> server emits message.delta...
  -> store.streamingText append
  -> MessageList 渲染 streaming bubble
  -> server emits message.completed
  -> query refresh messages
  -> store.streamingText clear
  -> runStatus = completed
```

这条流先跑通，前端就成立了。

## 10. 第一阶段不急着做的 UI

先不做：

- 多栏 inspector
- 复杂 settings 页面
- prompt playground
- memory browser
- tool timeline panel

先做好：

- thread sidebar
- message list
- streaming bubble
- composer
- run status bar

## 11. 推荐目录草案

```text
src/renderer/src/
  app/
    providers/
    store/
  features/
    threads/
      ThreadSidebar.tsx
    chat/
      ChatHeader.tsx
      MessageList.tsx
      MessageBubble.tsx
    composer/
      Composer.tsx
    runs/
      RunStatusBar.tsx
  components/
    markdown/
      MarkdownMessage.tsx
  lib/
    websocket/
      client.ts
    format/
      time.ts
```

## 12. 当前结论

Yachiyo 的前端第一阶段，本质上是一个围绕 `run` 和 `streaming message` 设计的 chat workspace。

关键点不是页面多，而是这几个边界要稳：

- 持久数据和实时状态分开
- markdown 渲染单独封层
- ws 逻辑不要散落在组件里
- UI 先围绕单线程、单活跃 run 做到顺
