---
title: yachiyo schedule
description: 创建、更新和查看定时任务及其运行历史。
---

管理[定时任务](/zh/docs/guides/schedules/)里描述的那些任务。

## `schedule list`

```bash
yachiyo schedule list [--json]
```

一个任务一行：

```
✓ daily-standup [0 9 * * *] id=abc123
✗ q1-review [@2026-04-01T09:00:00.000Z] id=def456
```

`✓` 表示已启用，`✗` 表示已停用。循环任务显示 cron 表达式；一次性任务显示 `@<runAt>`。

## `schedule add`

```bash
yachiyo schedule add --payload '<json>'
```

需要 `name`、`prompt`，以及 `cronExpression` 和 `runAt` 中**恰好一个**。两个都给或都不给都是校验错误。

| 字段             | 类型       | 必填   | 备注                                           |
| ---------------- | ---------- | ------ | ---------------------------------------------- |
| `name`           | `string`   | 是     | 用在线程标题和通知里                           |
| `prompt`         | `string`   | 是     | 作为第一条用户消息发出。必须自包含。           |
| `cronExpression` | `string`   | 二选一 | 五字段 cron，本地时区                          |
| `runAt`          | `string`   | 二选一 | ISO 8601 时间；触发一次后自我停用              |
| `workspacePath`  | `string`   | 否     | 绝对路径。省略则自动创建临时目录，跨运行复用。 |
| `modelOverride`  | `object`   | 否     | `{ "providerName": "...", "model": "..." }`    |
| `enabledTools`   | `string[]` | 否     | 工具白名单。省略表示全部；`[]` 表示全部禁用。  |
| `enabled`        | `boolean`  | 否     | 默认 `true`                                    |

```bash
yachiyo schedule add --payload '{
  "name": "morning-digest",
  "cronExpression": "0 8 * * 1-5",
  "prompt": "Summarize unread items in ~/notes/inbox.md from the last 24 hours. When done, call reportScheduleResult with status success and a one-sentence summary.",
  "workspacePath": "/Users/me/notes"
}'
```

:::tip
先跑一次 `yachiyo provider models`，把一个真实的模型名复制进 `modelOverride`。猜出来的模型字符串会在请求时才失败，而那次运行你并不在旁边看着。
:::

## `schedule update`

```bash
yachiyo schedule update --payload '<json>'
```

载荷必须包含 `id`。`name`、`prompt`、`cronExpression`、`runAt`、`workspacePath`、`modelOverride`、`enabledTools` 和 `enabled` 都可以提供；只有你传的会变。传 `null` 表示清空一个字段。

切换模式意味着设一个、清另一个：

```bash
# 循环 → 一次性
yachiyo schedule update --payload '{"id":"abc123","runAt":"2026-08-01T09:00:00.000Z","cronExpression":null}'

# 一次性 → 循环
yachiyo schedule update --payload '{"id":"abc123","cronExpression":"0 9 * * *","runAt":null}'
```

结果必须始终恰好设置一个调度字段。

| 字段            | 设为 `null` 的效果     |
| --------------- | ---------------------- |
| `workspacePath` | 回落到自动临时目录     |
| `modelOverride` | 移除；回落到工作区默认 |
| `enabledTools`  | 移除；所有工具变为可用 |

内置定时任务只接受 `enabled` 和 `cronExpression` 的改动。

## `schedule remove`

```bash
yachiyo schedule remove <id>
```

删除该定时任务及其运行历史。不可逆，也是在一次性任务触发前取消它的方式。内置定时任务不能删除 —— 停用即可。

## `schedule enable` / `disable`

```bash
yachiyo schedule enable <id>
yachiyo schedule disable <id>
```

两种情况下配置和历史都会保留。重新启用一个循环任务会让它在下一个 tick 就位 —— 错过的 tick 不会补跑。重新启用一个 `runAt` 已过去的一次性任务，会让它在大约 60 秒内触发。

## `schedule runs`

```bash
yachiyo schedule runs [<schedule-id>] [--limit <n>] [--json]
```

最近的运行，从新到旧 —— 所有任务的，或者指定某一个。默认 limit 为 20。

每次运行带一个运行状态（`running`、`completed`、`failed`、`skipped`），以及在智能体调用了 `reportScheduleResult` 时的结果状态（`success` 或 `failure`）加一段摘要。两者含义不同 —— 见[读懂结果](/zh/docs/guides/schedules/#读懂结果)。
