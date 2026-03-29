---
name: yachiyo-help
description: Complete reference for the Yachiyo CLI — soul traits, provider management, agent profiles, config, thread search, scheduled tasks, channel users/groups, and send commands
---

# Yachiyo Help

Reference for the Yachiyo CLI. The binary lives at `~/.yachiyo/bin/yachiyo`.

Read the detailed reference for each namespace before running unfamiliar commands:

- [soul.md](references/soul.md) — Manage evolving persona traits
- [providers.md](references/providers.md) — Manage AI providers
- [agents.md](references/agents.md) — Manage coding agent profiles
- [config.md](references/config.md) — Read and write configuration values
- [threads.md](references/threads.md) — Search historical conversations
- [schedule.md](references/schedule.md) — Manage scheduled tasks and view run history
- [channel.md](references/channel.md) — List channel users and groups
- [send.md](references/send.md) — Send notifications and channel messages

## Usage

```
yachiyo <namespace> <subcommand> [args...] [flags...]
```

## Namespaces

| Namespace  | Purpose                                 | Reference                               |
| ---------- | --------------------------------------- | --------------------------------------- |
| `soul`     | Manage evolving persona traits          | [soul.md](references/soul.md)           |
| `provider` | Manage AI providers                     | [providers.md](references/providers.md) |
| `agent`    | Manage coding agent profiles            | [agents.md](references/agents.md)       |
| `config`   | Read and write configuration            | [config.md](references/config.md)       |
| `thread`   | Search historical conversations         | [threads.md](references/threads.md)     |
| `schedule` | Manage scheduled tasks                  | [schedule.md](references/schedule.md)   |
| `channel`  | List channel users and groups           | [channel.md](references/channel.md)     |
| `send`     | Send notifications and channel messages | [send.md](references/send.md)           |

## Global Flags

| Flag               | Description                              |
| ------------------ | ---------------------------------------- |
| `--payload <json>` | Supply a JSON body for mutation commands |
| `--limit <n>`      | Max results for listing commands         |
| `--json`           | Output raw JSON for programmatic parsing |

## Key Paths

| Path                        | Purpose                                                    |
| --------------------------- | ---------------------------------------------------------- |
| `~/.yachiyo/config.toml`    | All settings: providers, tools, skills, memory, web search |
| `~/.yachiyo/SOUL.md`        | Assistant persona and evolving trait log                   |
| `~/.yachiyo/USER.md`        | User profile — who you are, your context, working style    |
| `~/.yachiyo/yachiyo.sqlite` | Thread and message database                                |
