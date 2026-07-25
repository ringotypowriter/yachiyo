---
title: Files and paths
description: What lives under ~/.yachiyo, and how to relocate it with YACHIYO_HOME.
---

Everything Yachiyo persists lives in one directory. There is no hidden state
elsewhere, no application-support cache doing something important, and no server
holding a copy.

## `~/.yachiyo`

| Path                          | What it is                                                                                             |
| ----------------------------- | ------------------------------------------------------------------------------------------------------ |
| `config.toml`                 | All settings — providers, tools, skills, memory, web search. [Reference](/docs/reference/config-toml/) |
| `channels.toml`               | Channel credentials and tuning. [Reference](/docs/reference/channels-toml/)                            |
| `yachiyo.sqlite`              | Threads, messages, tool calls, memory, schedules, run history                                          |
| `SOUL.md`                     | Assistant persona and evolving trait log                                                               |
| `USER.md`                     | Your profile, as structured tables                                                                     |
| `skills/core/`                | Bundled skills. Re-extracted on every launch — edits are lost.                                         |
| `skills/custom/`              | Your own skills                                                                                        |
| `bin/yachiyo`                 | CLI wrapper. Regenerated on every launch; do not edit.                                                 |
| `yachiyo.sock`                | Unix socket the `send` commands talk to                                                                |
| `temp-workspace/<thread-id>/` | Auto-created workspaces for threads with no assigned directory                                         |
| `file-history/`               | Run file snapshots (content-addressed)                                                                 |
| `workspace-indexes/`          | Search indexes for registered workspaces                                                               |
| `web-search/browser-session/` | The hidden browser session used by search                                                              |
| `browser-automation/`         | `useBrowser` sessions and profile                                                                      |
| `jotdowns/`                   | Quick notes captured with the jot-down shortcut                                                        |
| `activity-source.key`         | Key for the activity source                                                                            |

## `YACHIYO_HOME`

Set `YACHIYO_HOME` to move the entire directory:

```bash
YACHIYO_HOME=/tmp/yachiyo-test yachiyo thread list
```

Everything above relocates together — config, database, skills, sockets. This is
the clean way to run an isolated instance for testing without touching your real
history.

The CLI can also point at individual files, which is handy for reading a copy of
a database without moving anything else:

```bash
yachiyo thread list --db /path/to/yachiyo.sqlite
yachiyo config get --settings /path/to/config.toml
yachiyo soul traits list --soul /path/to/SOUL.md
```

## What to back up

| Priority | Path                                                                                           | Why                                              |
| -------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| High     | `yachiyo.sqlite`                                                                               | Your entire conversation history                 |
| High     | `SOUL.md`, `USER.md`                                                                           | Persona and profile — small, and slow to rebuild |
| High     | `skills/custom/`                                                                               | Skills you wrote                                 |
| Medium   | `config.toml`                                                                                  | Settings. Contains API keys — encrypt it.        |
| Medium   | `channels.toml`                                                                                | Bot credentials. Same warning.                   |
| Skip     | `temp-workspace/`, `file-history/`, `workspace-indexes/`, `web-search/`, `browser-automation/` | Regenerated, and large                           |

## What leaves your machine

Only the requests you cause: calls to the providers you configured, pages the
agent fetches, searches you run, and channel messages. There is no telemetry and
no hosted backend.

[Sync](/docs/guides/sync/) is the one exception, and it is opt-in and points at a
folder you choose — it copies `config.toml` (API keys included) and chat archives
into that directory.
