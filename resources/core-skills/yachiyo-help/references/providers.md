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
yachiyo provider set-default <id-or-name>
```

Move the specified provider to the top of the list, making it the default for new chats.

### List available models

```
yachiyo provider models <id-or-name>
```

Fetch and list available models for the specified provider.
