---
name: yachiyo-ghostty
description: Use this skill to monitor, inspect, and interact with the user's Ghostty terminal sessions via AppleScript. List terminals, check working directories and running processes, send commands, manage windows/tabs/splits, and navigate between panes. macOS only — requires Ghostty with AppleScript enabled.
---

# Yachiyo Ghostty

Use this skill when the user wants you to observe, monitor, or interact with their Ghostty terminal sessions.

Read [guide.md](references/guide.md) for the full AppleScript API reference.

## Agent Interaction Recipes

These recipes cover coordinating with TUI coding agents (Claude Code, Codex, Aider, etc.) running in Ghostty:

- [Detect running agents](references/recipe-detect-agents.md) — find and identify coding agents by terminal name and working directory
- [Send prompts to agents](references/recipe-send-prompts.md) — type prompts, submit them, send control sequences, and agent-specific key bindings
- [Multi-agent coordination](references/recipe-multi-agent.md) — fan-out tasks, poll status, collect results, launch multi-agent layouts
- [Observe agent output](references/recipe-observe-output.md) — workarounds for reading agent output (file handoff, `script` recording, git diff, clipboard relay)

## Prerequisites

- macOS only (AppleScript is a macOS technology)
- Ghostty 1.3+ with `macos-applescript` enabled (default: on)
- First use will trigger a macOS TCC permission prompt

## Stable Workflow

1. **Discover** — list all terminals to get IDs, names, and working directories.
2. **Identify** — find the terminal(s) relevant to the task by name or working directory.
3. **Observe** — read terminal names (reflects the running process) and working directories.
4. **Act** — input commands, send keys, or rearrange layout as needed.
5. **Verify** — re-list terminals or check names to confirm the action took effect.

## Core Operations

All operations use `osascript -e '...'` or `osascript <<'APPLESCRIPT' ... APPLESCRIPT` via Bash.

### List all terminals

```bash
osascript -e '
tell application "Ghostty"
  set out to ""
  repeat with t in terminals
    set out to out & id of t & tab & name of t & tab & working directory of t & linefeed
  end repeat
  out
end tell'
```

### Find terminal by working directory

```bash
osascript -e '
tell application "Ghostty"
  set matches to every terminal whose working directory contains "my-project"
  repeat with t in matches
    log (id of t & tab & name of t & tab & working directory of t)
  end repeat
end tell'
```

### Send a command to a terminal

```bash
osascript -e '
tell application "Ghostty"
  set t to terminal id "TARGET_ID"
  input text "your-command-here" to t
  send key "enter" to t
end tell'
```

### Focus a terminal

```bash
osascript -e '
tell application "Ghostty"
  focus terminal id "TARGET_ID"
end tell'
```

## Good Defaults

- Always list terminals first to get fresh IDs — do not cache IDs across calls.
- Use `working directory` and `name` properties for identification, not hardcoded IDs.
- Prefer `input text` + `send key "enter"` over raw key sequences for commands.
- When monitoring a long-running process, check the terminal `name` property — it typically reflects the foreground process.
- Do not close or rearrange terminals unless the user explicitly asks.
- Run `osascript` commands via Bash — keep AppleScript blocks readable and single-purpose.

## Limitations

- **No screen buffer read**: AppleScript cannot read the visible text/output of a terminal. You can only observe metadata (name, working directory) and send input.
- **Name reflects foreground process**: The `name` property shows what the terminal title is set to, which usually reflects the running command — use this as a proxy for "what is running."
- **macOS only**: This skill does not work on Linux or Windows.

## Output Rules

- Report what you observed (terminal count, names, working directories) concisely.
- When sending commands, state what you sent and to which terminal.
- If a terminal cannot be found, say so clearly and suggest the user check Ghostty is running.

## Verification

Before finishing:

- Confirm the target terminal was correctly identified (by name or working directory).
- Confirm any sent command was delivered to the intended terminal.
- If layout was changed, verify the new terminal arrangement.
