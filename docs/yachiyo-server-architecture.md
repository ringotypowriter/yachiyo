# Yachiyo Server Architecture

## 目标

Yachiyo 后端不是传统 chat API，也不是一套先验写死的 memory system。

当前阶段它的职责是：

- 管理多个 `Thread`
- 维护 `Append-Only Context`
- 以 `Harness` 作为执行单元
- 以 `Hook / Plugin` 作为扩展机制
- 用 `AI SDK` 驱动模型运行时
- 通过 Electron IPC Gateway 向前端持续推送事件

一句话：

> Yachiyo Server 是一个以 `Thread` 为主容器、以 `Append-Only Context` 为底座、以 `Hook / Plugin` 为扩展机制、以 `Harness` 为执行单元的本地运行时。

## 核心原则

### 多 Thread

系统默认支持多个 `Thread`，每个 `Thread` 都有自己的上下文演化轨迹和 run history。

### Append-Only Context

Context 不是随意覆盖的对象，而是持续 append 的日志；一次 `run` 读取的是某个时刻的 context view。

### Harness 不是 Tool

执行能力按 `Harness` 建模，而不是按离散 `Tool` 调用建模。

### Hook / Plugin 扩展

增强能力通过生命周期 hook 和 plugin capability 介入。

### Memory 先不做独立系统

当前不实现独立 memory runtime / memory store。

memory 相关能力先作为：

- `message.prepare` 之类 hook 的注入逻辑
- 某个 plugin 提供的 `memory search` capability

## 后端视角的核心对象

当前阶段只需要稳定这些概念：

- `Thread`
- `Run`
- `ContextEntry`
- `Harness`
- `HarnessInvocation`
- `Plugin`
- `PluginInvocation`

这里的重点是语义边界，而不是现在就把所有字段、表结构、文件路径写死。

## 运行主线

后端最小主线可以理解成：

```text
chat.send
  -> create run
  -> append user message into context
  -> run prepare hooks
  -> materialize context view
  -> choose reply harness
  -> inject allowed plugin capabilities
  -> stream output
  -> append result back into context
  -> complete run
```

这条主线里最重要的是顺序和职责，不是某个具体模块名。

## Hook / Plugin 角色

### Hook

Hook 是生命周期切点，例如：

- `message.prepare`
- `context.materialize`
- `response.complete`
- `run.complete`

### Plugin

Plugin 是可注册的能力单元，可以：

- 订阅 hook
- 注入上下文片段
- 暴露 callable capability
- 记录自己的 invocation

### Memory Search Plugin

当前最合适的 memory 形态，是一个 `memory search plugin`。

它可以：

- 在 prepare 阶段自动检索并注入
- 在某次 run 中作为 injected capability 被使用

## 当前文档边界

这份文档当前只负责说明：

- 后端不变量
- 模块职责边界
- 执行生命周期
- hook / plugin / harness 的关系

这份文档当前不负责提前写死：

- 具体目录结构
- service / repository 的精细拆分
- 数据库表字段细节
- 实现任务清单
