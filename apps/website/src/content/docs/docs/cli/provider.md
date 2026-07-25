---
title: yachiyo provider
description: List, inspect, and update AI providers, and set the default model for new chats.
---

Manages the providers configured in `~/.yachiyo/config.toml`. API keys are
redacted as `***` in all output.

## `provider list`

```bash
yachiyo provider list
```

Every configured provider, keys redacted.

## `provider show`

```bash
yachiyo provider show <id-or-name>
```

One provider in full, addressed by UUID or display name.

## `provider update`

```bash
yachiyo provider update <id-or-name> [--payload '<json>']
```

Merges a JSON patch into an existing provider. Only the fields you supply
change.

```bash
yachiyo provider update my-openai --payload '{"apiKey":"sk-..."}'
yachiyo provider update my-openai --payload '{"baseUrl":"https://proxy.internal/v1"}'
```

## `provider set-default`

```bash
yachiyo provider set-default <id-or-name> [--model <model>]
```

Promotes the provider to default and sets the model new chats start with —
updating both provider ordering and the `defaultModel` setting in one step.
Without `--model`, it picks that provider's first enabled model.

```bash
yachiyo provider set-default anthropic --model <model-name>
```

## `provider models`

```bash
yachiyo provider models                 # locally enabled models
yachiyo provider models <id-or-name>    # everything the provider's API offers
```

Without an argument you get a flat array of `{ provider, model }` for every
model you have enabled — the valid values for `modelOverride` fields in schedule
payloads and essential presets.

With a provider argument it calls the provider's API and lists what is actually
available, which is how you discover model names worth enabling.

:::tip
Look up model names before writing them into a payload. Guessing a model string
produces a run that fails at request time, not at config time.
:::

## See also

- [Providers and models](/docs/guides/providers/) — the concepts behind these
  commands
- [`yachiyo config`](/docs/cli/config/) — for settings these commands do not
  cover
