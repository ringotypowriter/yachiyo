# Providers — CLI Reference

Manage the AI providers configured by Yachiyo. Public provider settings live in
`~/.yachiyo/config.toml`; API keys and service-account private keys live in the
keychain-protected credential store. API keys are redacted in output.
With sync enabled, joined devices exchange provider credentials in encrypted
snapshots after automatically exchanging public keys. No separate sync password
or credential import is required. Codex OAuth session files stay device-local.

## Anthropic thinking

Claude models that reject manual thinking budgets use adaptive thinking with
`output_config.effort`. The selected reasoning level controls effort; the default
is `medium`. Older Claude models and other Anthropic-compatible models retain
their token budgets.

Fable 5/5.1, Mythos 5/5.1, Opus 5.5, and Sonnet 5.5 cannot disable thinking.
For these models, selecting off, disabling provider thinking, or running an
auxiliary task uses adaptive thinking with `low` effort. Thinking tokens can still
be generated and billed. Other models keep explicit thinking-off behavior.
See [Anthropic's thinking configuration table](https://platform.claude.com/docs/en/build-with-claude/thinking#configuring-thinking).

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
