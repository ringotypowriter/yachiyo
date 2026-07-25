---
title: Providers and models
description: Connect model providers, choose which models appear in the picker, and configure the tool model and reasoning effort.
---

Yachiyo has no built-in model and no hosted account. You bring providers, and
you can have as many as you like at once — switching per message is normal usage,
not an edge case.

Providers live in `~/.yachiyo/config.toml`. API keys are stored there in plain
text on your machine and are redacted in all CLI output.

## Adding a provider

**Settings → Providers → Add**, then pick a preset. The preset fills in the API
type and base URL; you supply the key.

| Preset               | API type         | Base URL                                            |
| -------------------- | ---------------- | --------------------------------------------------- |
| Anthropic            | `anthropic`      | `https://api.anthropic.com/v1`                      |
| OpenAI               | `openai`         | `https://api.openai.com/v1`                         |
| OpenAI (Codex OAuth) | `openai-codex`   | `https://chatgpt.com/backend-api/codex`             |
| Gemini               | `gemini`         | `https://generativelanguage.googleapis.com/v1beta`  |
| Google Vertex AI     | `vertex`         | — (uses project + location)                         |
| Vercel AI Gateway    | `vercel-gateway` | `https://ai-gateway.vercel.sh/v3/ai`                |
| OpenRouter           | `openai`         | `https://openrouter.ai/api/v1`                      |
| DeepSeek             | `openai`         | `https://api.deepseek.com/v1`                       |
| Moonshot             | `openai`         | `https://api.moonshot.cn/v1`                        |
| Kimi For Coding      | `anthropic`      | `https://api.kimi.com/coding/v1`                    |
| Zhipu GLM            | `anthropic`      | `https://open.bigmodel.cn/api/anthropic`            |
| Z.ai                 | `anthropic`      | `https://api.z.ai/api/anthropic`                    |
| Minimax              | `openai`         | `https://api.minimaxi.com/v1`                       |
| Mistral              | `openai`         | `https://api.mistral.ai/v1`                         |
| Aliyun Bailian       | `openai`         | `https://dashscope.aliyuncs.com/compatible-mode/v1` |
| PackyCode            | `anthropic`      | `https://www.packyapi.com/v1`                       |
| Ollama               | `openai`         | `http://localhost:11434/v1`                         |

Anything not on the list works too — pick the preset whose API shape matches
(most third-party endpoints are OpenAI- or Anthropic-compatible) and replace the
base URL.

### Local models

The **Ollama** preset points at `http://localhost:11434/v1` and needs no API key.
Any other OpenAI-compatible local server (llama.cpp, LM Studio, vLLM) works the
same way — set the base URL and leave the key blank if the server does not check
it.

### Vertex AI

Vertex does not use an API key. It needs `project`, `location`, and a service
account (`serviceAccountEmail` + `serviceAccountPrivateKey`) instead.

### Codex OAuth

The `openai-codex` type authenticates through a Codex CLI session rather than a
key. Point `codexSessionPath` at your Codex `auth.json` and Yachiyo reads the
account from it.

## Choosing which models appear

Fetching a provider's catalogue returns everything the API knows about, which is
usually far more than you want in a picker. So each provider keeps two lists:

- `modelList.enabled` — shows up in the model picker
- `modelList.disabled` — known, deliberately hidden

Only enabled models are selectable. Curate the list once and the picker stays
short.

```bash
yachiyo provider models openai      # everything the API offers
yachiyo provider models             # what you have actually enabled
```

There is also `modelList.imageIncapable` — models are assumed to accept images,
so list the ones that do not.

## The default model

The `defaultModel` setting decides what new threads start with:

```bash
yachiyo provider set-default anthropic --model <model-name>
```

That promotes the provider to default and sets the active model in one step.
Without `--model` it picks the provider's first enabled model. Individual threads
and messages can override it freely.

## The tool model

Separate from the model that talks to you, Yachiyo uses a **tool model** for
background work:

- thread titles
- memory generation and distillation
- context handoff when a thread outgrows its window
- image-to-text descriptions
- group-chat probes and reply rewriting
- the built-in translator

Three modes:

| Mode       | Behavior                                                                     |
| ---------- | ---------------------------------------------------------------------------- |
| `default`  | Reuse the chat model. Simple, and the most expensive option.                 |
| `custom`   | Name a specific provider and model.                                          |
| `disabled` | Skip auxiliary generation entirely. Titles stay generic, distillation stops. |

This work is frequent and low-stakes, so `custom` pointed at something small and
fast is usually the right setup.

```bash
yachiyo config get toolModel
yachiyo config set toolModel.mode '"custom"'
```

## Reasoning effort

For models that expose a reasoning budget, each provider can carry a `reasoning`
block: which effort levels are offered (`low`, `medium`, `high`, `xhigh`, `max`),
which is the default, and whether `off` is allowed. Effort is then selectable in
the composer per message.

## Managing providers from the CLI

```bash
yachiyo provider list                       # all providers, keys redacted
yachiyo provider show openai                # one provider in full
yachiyo provider update openai --payload '{"apiKey":"sk-..."}'
yachiyo provider set-default openai --model <model-name>
```

Full details in the [`provider` CLI reference](/docs/cli/provider/).

:::caution[Keys in config.toml]
`config.toml` stores API keys in plain text. Do not commit it and do not put it
in a shared folder.

CLI output is safer than the file: every command replaces `apiKey` values with
`***`, including `yachiyo config get`. Reading the file directly is the only way
to print a key.
:::
