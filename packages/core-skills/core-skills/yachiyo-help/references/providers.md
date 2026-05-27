# Providers — CLI Reference

Manage the AI providers configured in `~/.yachiyo/config.toml`. API keys are redacted in output.

## Commands

### List all providers

```
yachiyo provider list
```

List all configured providers (API keys shown as `***`).

### Show a provider

```
yachiyo provider show <id-or-name>
```

Show full details of one provider by its ID or display name.

### Update a provider

```
yachiyo provider update <id-or-name> [--payload '<json>']
```

Patch a provider's fields using a JSON object.

```bash
yachiyo provider update my-openai --payload '{"apiKey":"sk-..."}'
```

### Set the default provider

```
yachiyo provider set-default <id-or-name> [--model <model>]
```

Promote the specified provider to default and set the active model for new chats. Without `--model`, picks the first enabled model from that provider.

This updates both the provider ordering and the `defaultModel` setting.

### List enabled models

```
yachiyo provider models
```

List all locally enabled models across all providers. Returns a flat array of `{ provider, model }` objects.

> **Tip:** Use this command to discover available model names when you need to fill `modelOverride` fields (e.g. in schedule payloads or essential presets).

### Fetch available models from API

```
yachiyo provider models <id-or-name>
```

Fetch and list all available models from the specified provider's API (not just locally enabled ones).
