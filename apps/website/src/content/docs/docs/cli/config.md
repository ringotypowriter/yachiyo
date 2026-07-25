---
title: yachiyo config
description: Read and write any configuration value by dot-separated path.
---

Direct access to `~/.yachiyo/config.toml`. Everything is addressed by a
dot-separated path.

## `config get`

```bash
yachiyo config get [path]
```

Prints the whole config as JSON, or the value at `path`.

```bash
yachiyo config get
yachiyo config get skills.enabled
yachiyo config get providers.0.name
yachiyo config get toolModel
```

Provider `apiKey` values are redacted to `***`, including inside nested paths.

## `config set`

```bash
yachiyo config set <path> <value>
```

The value is parsed as JSON when possible and treated as a string otherwise.
This means **strings need to be quoted twice** — once for JSON, once for the
shell:

```bash
yachiyo config set skills.enabled '["yachiyo-help","my-skill"]'
yachiyo config set chat.activeRunEnterBehavior '"enter-queues-follow-up"'
yachiyo config set memory.autoRecall true
yachiyo config set chat.stripCompactThresholdTokens 40000
```

## Common paths

| Path                          | Type      | Description                                            |
| ----------------------------- | --------- | ------------------------------------------------------ |
| `defaultModel.providerName`   | `string`  | Provider for new chats                                 |
| `defaultModel.model`          | `string`  | Model for new chats                                    |
| `toolModel.mode`              | `string`  | `"default"`, `"custom"`, or `"disabled"`               |
| `skills.enabled`              | `array`   | Enabled skill names                                    |
| `memory.enabled`              | `boolean` | Master memory switch                                   |
| `memory.autoRecall`           | `boolean` | Pull recalled context into runs                        |
| `chat.autoMemoryDistillation` | `boolean` | Distill memory after runs                              |
| `webSearch.defaultProvider`   | `string`  | `"google-browser"`, `"duckduckgo-browser"`, or `"exa"` |
| `workspace.savedPaths`        | `array`   | Registered workspace directories                       |
| `providers.N.name`            | `string`  | Name of the N-th provider (zero-indexed)               |

The full shape is documented in the
[`config.toml` reference](/docs/reference/config-toml/).

:::tip
To change the default provider and model, prefer
[`yachiyo provider set-default`](/docs/cli/provider/#provider-set-default) over
editing `defaultModel.*` by hand — it keeps provider ordering consistent.
:::

:::note[Editing while the app runs]
The runtime caches the parsed config and invalidates that cache when the file's
mtime changes, so a CLI write is picked up on the next read — no restart needed.

An already-open Settings window still shows what it loaded, though. Reopen it
before editing the same area from the UI, or you will write stale values back
over your change. Schedules are a separate case: the scheduler re-syncs from
config about every 60 seconds.
:::
