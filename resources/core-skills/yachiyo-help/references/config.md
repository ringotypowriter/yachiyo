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
