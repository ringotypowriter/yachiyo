---
title: yachiyo config
description: 用点分路径读写任意配置项。
---

直接访问 `~/.yachiyo/config.toml`。一切都通过点分路径寻址。

## `config get`

```bash
yachiyo config get [path]
```

以 JSON 打印整份配置，或打印 `path` 处的值。

```bash
yachiyo config get
yachiyo config get skills.enabled
yachiyo config get providers.0.name
yachiyo config get toolModel
```

供应商的 `apiKey` 值会被打码成 `***`，嵌套路径里的也一样。

## `config set`

```bash
yachiyo config set <path> <value>
```

值会尽可能按 JSON 解析，解析不了则当作字符串。这意味着**字符串需要引两次** —— 一次给 JSON，一次给 shell：

```bash
yachiyo config set skills.enabled '["yachiyo-help","my-skill"]'
yachiyo config set chat.activeRunEnterBehavior '"enter-queues-follow-up"'
yachiyo config set memory.autoRecall true
yachiyo config set chat.stripCompactThresholdTokens 40000
```

## 常用路径

| 路径                          | 类型      | 说明                                                  |
| ----------------------------- | --------- | ----------------------------------------------------- |
| `defaultModel.providerName`   | `string`  | 新对话使用的供应商                                    |
| `defaultModel.model`          | `string`  | 新对话使用的模型                                      |
| `toolModel.mode`              | `string`  | `"default"`、`"custom"` 或 `"disabled"`               |
| `skills.enabled`              | `array`   | 已启用的技能名                                        |
| `memory.enabled`              | `boolean` | 记忆总开关                                            |
| `memory.autoRecall`           | `boolean` | 把调取到的上下文带进运行                              |
| `chat.autoMemoryDistillation` | `boolean` | 运行后蒸馏记忆                                        |
| `webSearch.defaultProvider`   | `string`  | `"google-browser"`、`"duckduckgo-browser"` 或 `"exa"` |
| `workspace.savedPaths`        | `array`   | 已注册的工作区目录                                    |
| `providers.N.name`            | `string`  | 第 N 个供应商的名字（从 0 开始）                      |

完整结构见 [`config.toml` 参考](/zh/docs/reference/config-toml/)。

:::tip
要改默认供应商和模型，优先用 [`yachiyo provider set-default`](/zh/docs/cli/provider/#provider-set-default)，而不是手改 `defaultModel.*` —— 它会保持供应商排序的一致性。
:::

:::note[应用运行时编辑]
运行时会缓存解析后的配置，并在文件 mtime 变化时让缓存失效，所以命令行的写入会在下一次读取时被拾取 —— 不需要重启。

不过一个已经打开的设置窗口显示的还是它当初加载的内容。在界面上编辑同一块区域之前先重新打开它，否则你会把旧值写回去、盖掉你刚才的改动。定时任务是另一种情况：调度器大约每 60 秒从配置重新同步一次。
:::
