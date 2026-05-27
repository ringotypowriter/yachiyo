# Config — CLI Reference

Configuration is stored at `~/.yachiyo/config.toml`. All values are accessible via dot-separated paths.

## Commands

### Read config

```
yachiyo config get [path]
```

Print the full config as JSON, or a nested value at `path`.

```bash
yachiyo config get
yachiyo config get skills.enabled
yachiyo config get providers.0.name
```

### Write config

```
yachiyo config set <path> <value>
```

Set a config value. The value is parsed as JSON if possible, otherwise treated as a string.

```bash
yachiyo config set skills.enabled '["yachiyo-help", "my-skill"]'
yachiyo config set chat.activeRunEnterBehavior '"enter-queues-follow-up"'
```

## Common Paths

| Path                        | Type     | Description                                            |
| --------------------------- | -------- | ------------------------------------------------------ |
| `defaultModel.providerName` | `string` | Active provider name for new chats                     |
| `defaultModel.model`        | `string` | Active model for new chats                             |
| `toolModel.mode`            | `string` | Tool model mode: `"default"`, `"custom"`, `"disabled"` |
| `skills.enabled`            | `array`  | List of enabled skill names                            |
| `providers.N.name`          | `string` | Name of the N-th provider (zero-indexed)               |

> To change the default provider and model, prefer `yachiyo provider set-default <name> [--model <model>]` over editing these paths directly. To discover valid model names, run `yachiyo provider models`.
