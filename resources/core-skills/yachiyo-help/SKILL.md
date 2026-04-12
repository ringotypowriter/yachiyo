---
name: yachiyo-help
description: Complete reference for the Yachiyo CLI — soul traits, provider management, agent profiles, config, thread search, scheduled tasks, channel users/groups, group monitor status control, and send commands
---

# Yachiyo Help

Reference for the Yachiyo CLI. The binary lives at `~/.yachiyo/bin/yachiyo`.

> **IMPORTANT:** The Yachiyo CLI (`yachiyo` command) is NOT the Yachiyo desktop app (`Yachiyo.app`). You are running _inside_ Yachiyo.app — never attempt to open, run, or execute `Yachiyo.app` via the bash tool. Doing so would spawn a recursive instance and is blocked by the security layer.

Read the detailed reference for each namespace before running unfamiliar commands:

- [soul.md](references/soul.md) — Manage evolving persona traits
- [providers.md](references/providers.md) — Manage AI providers
- [agents.md](references/agents.md) — Manage coding agent profiles
- [config.md](references/config.md) — Read and write configuration values
- [threads.md](references/threads.md) — Search historical conversations
- [schedule.md](references/schedule.md) — Manage scheduled tasks and view run history
- [channel.md](references/channel.md) — List channel users/groups and change group monitor status
- [send.md](references/send.md) — Send notifications and channel messages

## Usage

```
yachiyo <namespace> <subcommand> [args...] [flags...]
```

## Namespaces

| Namespace  | Purpose                                                   | Reference                               |
| ---------- | --------------------------------------------------------- | --------------------------------------- |
| `soul`     | Manage evolving persona traits                            | [soul.md](references/soul.md)           |
| `provider` | Manage AI providers                                       | [providers.md](references/providers.md) |
| `agent`    | Manage coding agent profiles                              | [agents.md](references/agents.md)       |
| `config`   | Read and write configuration                              | [config.md](references/config.md)       |
| `thread`   | Search historical conversations                           | [threads.md](references/threads.md)     |
| `schedule` | Manage scheduled tasks                                    | [schedule.md](references/schedule.md)   |
| `channel`  | List channel users/groups and change group monitor status | [channel.md](references/channel.md)     |
| `send`     | Send notifications and channel messages                   | [send.md](references/send.md)           |

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
| `~/.yachiyo/bin/yachiyo`    | CLI wrapper (auto-generated, do not edit)                  |

## Troubleshooting: `yachiyo: command not found`

When a user reports that `yachiyo` is not found after first install, follow these steps in order:

### 1. Check if the wrapper exists

```bash
ls -la ~/.yachiyo/bin/yachiyo
```

If the file is missing, the user should **re-launch the Yachiyo desktop app** — it auto-generates the wrapper on startup.

### 2. Check for the `/usr/local/bin` symlink

```bash
ls -la /usr/local/bin/yachiyo
```

If the symlink exists and points to `~/.yachiyo/bin/yachiyo`, the CLI should work immediately. If not, check whether `/usr/local/bin` exists and is writable:

```bash
ls -ld /usr/local/bin
```

If the directory is missing or not writable, you can create the symlink manually (may need `sudo`):

```bash
sudo mkdir -p /usr/local/bin
sudo ln -sf ~/.yachiyo/bin/yachiyo /usr/local/bin/yachiyo
```

### 3. Check PATH (fallback when symlink is unavailable)

If `/usr/local/bin` symlink is not an option, verify that `~/.yachiyo/bin` is on the user's PATH:

```bash
echo $PATH | tr ':' '\n' | grep yachiyo
```

If missing, check the shell profile for the PATH entry:

- **zsh:** `grep yachiyo ~/.zshrc`
- **bash:** `grep yachiyo ~/.bashrc ~/.bash_profile`
- **fish:** `grep yachiyo ~/.config/fish/config.fish`

If the entry is missing, re-launch the Yachiyo desktop app to have it added automatically, or add it manually:

- **zsh/bash:** `export PATH="$HOME/.yachiyo/bin:$PATH"` in the appropriate profile
- **fish:** `fish_add_path ~/.yachiyo/bin`

After editing a profile, the user must either **open a new terminal** or source the file (e.g., `source ~/.zshrc`).

### 4. Quick fix for the current session

If the user just needs it working right now without restarting the terminal:

```bash
# Works in any shell for the current session
export PATH="$HOME/.yachiyo/bin:$PATH"
```

Or for fish:

```fish
fish_add_path ~/.yachiyo/bin
```
