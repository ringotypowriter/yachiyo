---
title: yachiyo agent
description: 切换子智能体运行模式，并管理遗留的 ACP 智能体档案。
---

控制 `delegateTask` 怎么干活：用进程内的 **worker** 子智能体（默认），还是外部的 **ACP** 智能体（已废弃）。

## `agent mode`

```bash
yachiyo agent mode worker
yachiyo agent mode acp
```

设置子智能体运行模式。Worker 模式通过 `delegateTask` 暴露 Explore、Plan、Review 和 General。ACP 模式路由到外部智能体进程，已废弃。

## `agent list`

```bash
yachiyo agent list
```

显示当前模式，以及仍然配置着的 ACP 档案。

## ACP 档案命令

:::caution[已废弃]
ACP 智能体已废弃。现有档案仍可工作，但新的配置应该用 worker 模式。
:::

```bash
yachiyo agent show <id-or-name>
yachiyo agent add --payload '<json>'
yachiyo agent update <id-or-name> [--payload '<json>']
yachiyo agent remove <id-or-name>
yachiyo agent enable <id-or-name>
yachiyo agent disable <id-or-name>
```

`add` 至少需要 `name` 和 `command`。省略 `id` 会自动生成，其余字段取安全的默认值（`enabled: true`、`args: []`、`env: {}`）。

```bash
yachiyo agent add --payload '{
  "name": "My Agent",
  "command": "npx",
  "args": ["-y", "some-acp-agent"],
  "env": {"MODE": "prod"}
}'
```

`update` 是合并式的 —— 只有你提供的字段会变，`id` 始终保留。

```bash
yachiyo agent update my-agent --payload '{"description":"Updated","args":["-y","some-acp-agent@latest"]}'
```

`disable` 把档案留在配置里但不再提供；`remove` 则永久删除。

## 档案字段

| 字段          | 类型                    | 说明                                          |
| ------------- | ----------------------- | --------------------------------------------- |
| `id`          | `string`                | 稳定标识符，添加时自动生成                    |
| `name`        | `string`                | 显示名称                                      |
| `enabled`     | `boolean`               | 该档案是否启用                                |
| `description` | `string`                | 界面上显示的简短描述                          |
| `command`     | `string`                | 要启动的可执行文件（`npx`、`node`、绝对路径） |
| `args`        | `string[]`              | 传给该命令的参数                              |
| `env`         | `Record<string,string>` | 额外的环境变量                                |

## 另见

- [子智能体与编码智能体](/zh/docs/guides/coding-agents/)
