---
title: Files and paths
description: What lives under ~/.yachiyo, and how to relocate it with YACHIYO_HOME.
---

Yachiyo's persistent data files live in one directory. It defaults to
`/Users/<you>/.yachiyo` on macOS and `C:\Users\<you>\.yachiyo` on Windows. The
operating system's credential encryption protects the key for the local model
provider vault; there is no Yachiyo server holding a copy.

## `~/.yachiyo`

| Path                              | What it is                                                                                                                             |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `config.toml`                     | Settings and provider metadata; model-provider secrets are excluded. May include an Exa key. [Reference](/docs/reference/config-toml/) |
| `provider-credentials.enc`        | Encrypted model-provider API keys and Vertex private keys                                                                              |
| `provider-credentials.key`        | Vault key wrapped by the operating system's credential encryption                                                                      |
| `channels.toml`                   | Channel credentials and tuning. [Reference](/docs/reference/channels-toml/)                                                            |
| `yachiyo.sqlite`                  | Threads, messages, tool calls, memory, schedules, run history                                                                          |
| `SOUL.md`                         | Assistant persona and evolving trait log                                                                                               |
| `USER.md`                         | Your profile, as structured tables                                                                                                     |
| `skills/core/`                    | Bundled skills. Re-extracted on every launch — edits are lost.                                                                         |
| `skills/custom/`                  | Your own skills                                                                                                                        |
| `bin/yachiyo` / `bin/yachiyo.cmd` | Platform CLI wrapper. Regenerated on every launch; do not edit.                                                                        |
| `yachiyo.sock`                    | macOS Unix socket used by live-app CLI commands; Windows uses a named pipe instead                                                     |
| `temp-workspace/<thread-id>/`     | Auto-created workspaces for threads with no assigned directory                                                                         |
| `file-history/`                   | Run file snapshots (content-addressed)                                                                                                 |
| `workspace-indexes/`              | Search indexes for registered workspaces                                                                                               |
| `web-search/browser-session/`     | The hidden browser session used by search                                                                                              |
| `browser-automation/`             | `useBrowser` sessions and profile                                                                                                      |
| `jotdowns/`                       | Quick notes captured with the jot-down shortcut                                                                                        |
| `activity-source.key`             | Key for the activity source                                                                                                            |

## `YACHIYO_HOME`

Set `YACHIYO_HOME` to move the entire directory:

```bash
YACHIYO_HOME=/tmp/yachiyo-test yachiyo thread list
```

```powershell
$env:YACHIYO_HOME = 'D:\Yachiyo Test'
yachiyo thread list
```

Everything above relocates together — config, database, skills, and the command
endpoint identity. Windows derives a stable `\\.\pipe\yachiyo-<id>` name from
the normalized home path rather than creating a socket file. This is the clean
way to run an isolated instance for testing without touching your real history.

The CLI can also point at individual files, which is handy for reading a copy of
a database without moving anything else:

```bash
yachiyo thread list --db /path/to/yachiyo.sqlite
yachiyo config get --settings /path/to/config.toml
yachiyo soul traits list --soul /path/to/SOUL.md
```

## What to back up

| Priority | Path                                                                                           | Why                                                                  |
| -------- | ---------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| High     | `yachiyo.sqlite`                                                                               | Your entire conversation history                                     |
| High     | `SOUL.md`, `USER.md`                                                                           | Persona and profile — small, and slow to rebuild                     |
| High     | `skills/custom/`                                                                               | Skills you wrote                                                     |
| Medium   | `config.toml`                                                                                  | Settings; may contain an Exa web-search key. Keep it private.        |
| Medium   | `provider-credentials.enc`, `provider-credentials.key`                                         | Device-local provider secrets. Configure them again on a new device. |
| Medium   | `channels.toml`                                                                                | Bot credentials. Keep it private.                                    |
| Skip     | `temp-workspace/`, `file-history/`, `workspace-indexes/`, `web-search/`, `browser-automation/` | Regenerated, and large                                               |

## What leaves your machine

Only the requests you cause: calls to the providers you configured, pages the
agent fetches, searches you run, and channel messages. There is no telemetry and
no hosted backend.

[Sync](/docs/guides/sync/) is the one exception, and it is opt-in and points at a
folder you choose. It copies settings data in `config.toml`, `skills/custom/`
(including script contents), and chat archives; the provider vault and its key
stay on this device. Because settings or custom scripts may still contain other
secrets such as an Exa key, keep the sync folder private.
