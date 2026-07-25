---
title: yachiyo send
description: 从脚本里推送系统通知和频道消息。需要应用处于运行状态。
---

发完即走的命令，通过 `~/.yachiyo/yachiyo.sock` 这个 Unix 域套接字和运行中的八千代应用通信。

:::caution[应用必须在运行]
和命令行的其余部分不同，`send` 需要一个活着的应用。没有的话你会看到：

```
Yachiyo app is not running. Start the app first.
```

:::

## `send notification`

```bash
yachiyo send notification <message> [--title <title>]
```

推送一条原生系统通知。

| 参数              | 说明                   |
| ----------------- | ---------------------- |
| `<message>`       | 正文（必填）           |
| `--title <title>` | 标题，默认为 `Yachiyo` |

```bash
yachiyo send notification "Build completed"
yachiyo send notification "Tests passed" --title "CI Result"
```

输出：`Notification sent.`

这是长时间任务上最省事的一招：

```bash
pnpm run build && yachiyo send notification "Build done" --title "yachiyo"
```

## `send channel`

```bash
yachiyo send channel <id> <message>
```

以机器人的身份，把文本直接发给某个频道用户或群组所在的平台。不创建线程，不做推理 —— 消息直接发出去。

| 参数        | 说明                      |
| ----------- | ------------------------- |
| `<id>`      | 频道用户或群组的内部 UUID |
| `<message>` | 要发送的文本              |

ID 从 [`channel users` 或 `channel groups`](/zh/docs/cli/channel/) 获取：

```bash
yachiyo channel users --json
yachiyo send channel a1b2c3d4-... "Hello from the CLI"
```

输出：`Message sent.`

### 注意事项

- 对应平台的频道服务必须在运行。如果没有，从你这边看发送会静默失败，服务端会记日志。
- 对 QQ 来说，用户 ID 发的是私聊消息，群组 ID 发的是群消息。
