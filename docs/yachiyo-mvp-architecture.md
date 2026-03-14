# Yachiyo MVP 架构设计

## 目标

Yachiyo 当前阶段先做一个可用、可扩展、前端体验清晰的 AI Chat 产品壳，而不是一次性做成完整的通用 Agent 平台。

第一阶段重点：

- 稳定的桌面端 AI Chat 体验
- 流式输出与 persistent connection
- 多 `Thread` 会话模型
- `Append-Only Context` 的后端认知底座
- 为 `Harness`、`Hook / Plugin` 预留扩展位

一句话：

> 先做 `Chat-first, Agent-ready` 的 Yachiyo。

## 产品定位

Yachiyo 是一个桌面端的 AI Chat / Agent Shell。

它当前阶段的形态应该是：

- 表面上是一个体验好的聊天客户端
- 内部上是一个有状态的本地服务系统
- 协议层从一开始就按事件流来设计
- 前后端之间当前通过 Electron IPC 维持事件流，未来如有需要再抽象成可替换传输层

所以现在不要把它理解成一个已经定死实现细节的后端平台，而应该理解成：

- 先把聊天体验、状态模型、实时通信、扩展骨架搭起来
- 再把 Agent 能力一层层塞进去

## 顶层结构

推荐结构：

```text
Electron App
  ├─ Renderer (React UI)
  ├─ Main Process
  └─ Local Yachiyo Server
       ├─ IPC Gateway
       ├─ Orchestrator
       ├─ Model Runtime
       ├─ Harness Runtime
       ├─ Hook / Plugin Runtime
       └─ Storage
```

这里的重点不是某个具体文件怎么拆，而是职责边界：

- Renderer 负责界面与交互
- Main Process 负责桌面壳和生命周期
- Local Server 负责会话、上下文、执行与事件流

## 核心原则

### 多 Thread

Yachiyo 默认就是多 `Thread` 系统，不是单 chat 的历史记录补丁。

### Append-Only Context

后端上下文不能是随意覆盖的可变对象，而应该以 append-only 的方式演化，并在运行时投影成某次 `run` 使用的 context view。

### Harness 不是 Tool

执行单元用 `Harness` 建模，而不是简单 `Tool` 调用。

### Hook / Plugin 扩展

增强能力先通过 `Hook / Plugin` 介入，不急着做重型子系统。

### Memory 当前不做独立系统

memory 相关能力先作为 plugin capability 或 hook 注入存在，例如 `message.prepare` 阶段的 memory search injection。

## 最小闭环

第一阶段只需要跑通下面这条链路：

1. 用户在前端发送消息
2. 前端通过 WebSocket 发起一次 `run`
3. 后端构造上下文并执行默认 reply path
4. 流式输出持续推回前端
5. run 结束后持久化必要结果

这就已经是一个真正可用的第一版 Yachiyo。

## 核心对象

当前阶段只需要稳定这些对象概念：

- `Thread`
- `Message`
- `Run`
- `ContextEntry`
- `HarnessInvocation`
- `PluginInvocation`

这里更重要的是对象语义和关系，而不是现在就写死全部字段和表结构。

## 技术方向

当前确认的方向：

- 桌面壳：Electron
- 前端：React + TypeScript
- 实时通信：WebSocket
- Markdown 渲染：streamdown
- 代码高亮：shiki
- 模型运行时：AI SDK
- 本地存储：SQLite 路线

## 文档策略

当前文档只负责定义：

- 不变量
- 术语
- 生命周期
- 协议契约
- 模块边界

当前文档不负责提前写死：

- 具体文件结构
- 过细的 service / repository 切分
- 过早的数据库细节
- 过细的实现步骤
