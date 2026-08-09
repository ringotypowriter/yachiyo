---
title: CLI overview
description: The yachiyo command — namespaces, global flags, and what to do when the command is not found.
---

The `yachiyo` command drives the same local instance the desktop app uses. Most
of it reads and writes `~/.yachiyo` directly, so it works whether or not the app
is running — the exception is `send`, which needs a live app.

```
yachiyo <namespace> <subcommand> [args...] [flags...]
```

Output is JSON unless a command says otherwise. `yachiyo <namespace> --help`
prints detailed help for any namespace.

:::tip[This is mostly the agent's control surface]
Yachiyo ships with the `yachiyo-help` skill enabled, which documents every
command below. That means the assistant can run these itself — creating a
schedule, approving a channel user, curating a model list — when you ask it in
plain language.

Reach for the CLI directly when you want it in a script, a CI step, or a shell
pipeline. For one-off changes, asking is faster and less error-prone than
hand-writing a JSON payload.
:::

## Namespaces

| Namespace                         | Purpose                                               |
| --------------------------------- | ----------------------------------------------------- |
| [`soul`](/docs/cli/soul/)         | Manage evolving persona traits                        |
| [`provider`](/docs/cli/provider/) | Manage AI providers and models                        |
| [`agent`](/docs/cli/agent/)       | Subagent runtime mode and ACP profiles                |
| [`config`](/docs/cli/config/)     | Read and write configuration values                   |
| [`thread`](/docs/cli/thread/)     | Search and inspect conversation history               |
| [`schedule`](/docs/cli/schedule/) | Manage scheduled tasks and run history                |
| [`channel`](/docs/cli/channel/)   | List channel users and groups, set status and labels  |
| [`send`](/docs/cli/send/)         | Send notifications and channel messages               |
| `doctor`                          | Diagnose platform runtime, binaries, and capabilities |

`yachiyo doctor` prints a readable platform report. `yachiyo doctor --json`
prints only structured JSON, which is safe to attach to a bug report: it does
not include provider secrets, credential keys, auth files, or an environment
dump.

## Global flags

| Flag                | Default                     | Description                             |
| ------------------- | --------------------------- | --------------------------------------- |
| `--settings <path>` | `~/.yachiyo/config.toml`    | Settings file path                      |
| `--soul <path>`     | `~/.yachiyo/SOUL.md`        | Soul document path                      |
| `--db <path>`       | `~/.yachiyo/yachiyo.sqlite` | Database file path                      |
| `--payload <json>`  | —                           | JSON body for mutation commands         |
| `--limit <n>`       | 5                           | Max results for listing commands        |
| `--json`            | off                         | Raw JSON instead of human-readable text |
| `--help`            | —                           | Help for a command or namespace         |

Some commands override the limit default — `thread list` uses 10, `schedule
runs` uses 20.

The path flags exist so you can point the CLI at an isolated workspace. Setting
`YACHIYO_HOME` moves all three at once, which is usually easier.

## Secrets in output

Every command replaces `apiKey` values with `***` before printing, including
`yachiyo config get`. Provider API keys are stored in the encrypted,
device-local credential vault rather than `config.toml`, and are not synced.

Channel bot tokens in `channels.toml` are **not** covered by that redaction.

## Scripting

`--json` gives you machine-readable output for everything:

```bash
# Threads updated recently, as JSON
yachiyo thread list --limit 20 --json | jq '.[] | .title'

# Notify yourself when a long build finishes
make release && yachiyo send notification "Release build done" --title "CI"
```

## `command not found`

Ask Yachiyo first:

> The `yachiyo` command isn't found in my terminal. Fix it.

It has the whole diagnostic path in its help skill and shell access to run it,
including editing your shell profile. The app not being on your PATH does not
stop the app from fixing your PATH.

<details>
<summary>Diagnosing it yourself</summary>

The desktop app writes the platform wrapper on every launch and then tries to
make it reachable. When that has not worked, use the matching platform section.

### Windows

The wrapper is `%USERPROFILE%\.yachiyo\bin\yachiyo.cmd`. The app adds that
directory to the current user's `PATH` without administrator access.

```powershell
Test-Path "$env:USERPROFILE\.yachiyo\bin\yachiyo.cmd"
($env:Path -split ';') | Where-Object { $_ -like '*\.yachiyo\bin' }
```

If the wrapper exists but the second command finds nothing, relaunch Yachiyo so
it can repair the user `PATH`. Then close and reopen PowerShell, Command Prompt,
or bundled Bash; an already-running terminal keeps its old environment. Confirm
with:

```powershell
yachiyo doctor --json
```

### macOS

**1. Does the wrapper exist?**

```bash
ls -la ~/.yachiyo/bin/yachiyo
```

Missing means the app has not generated it — relaunch Yachiyo.

**2. Is the symlink there?**

```bash
ls -la /usr/local/bin/yachiyo
```

If it is missing, check whether the directory exists and is writable:

```bash
ls -ld /usr/local/bin
```

You can create the link by hand:

```bash
sudo mkdir -p /usr/local/bin
sudo ln -sf ~/.yachiyo/bin/yachiyo /usr/local/bin/yachiyo
```

**3. Is `~/.yachiyo/bin` on your PATH?**

```bash
echo $PATH | tr ':' '\n' | grep yachiyo
```

If not, the app adds it to your shell profile on launch — check
`~/.zshrc`, `~/.bashrc` / `~/.bash_profile`, or `~/.config/fish/config.fish`.
To add it yourself:

```bash
export PATH="$HOME/.yachiyo/bin:$PATH"     # zsh / bash
```

```fish
fish_add_path ~/.yachiyo/bin               # fish
```

Either way you need a new terminal, or to source the profile.

</details>

:::note
The wrapper is regenerated on every app launch and points at the running
installation. Do not edit it.
:::
