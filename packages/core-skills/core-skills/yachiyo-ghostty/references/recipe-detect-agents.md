# Recipe: Detect Running Coding Agents

Identify which Ghostty terminals have coding agents (Claude Code, Codex, Aider, etc.) running in them.

## Known Agent Signatures

TUI coding agents can be identified by their terminal `name` property, which reflects the foreground process:

| Agent        | Likely `name` contains | Notes                       |
| ------------ | ---------------------- | --------------------------- |
| Claude Code  | `claude`               | The `claude` CLI process    |
| OpenAI Codex | `codex`                | The `codex` CLI process     |
| Aider        | `aider`                | Python-based, shows `aider` |
| Goose        | `goose`                | Shows `goose session`       |
| Amp          | `amp`                  | Shows `amp`                 |

The `name` depends on shell integration — if the shell sets the terminal title to the running command (common with fish, zsh with precmd, etc.), this works reliably.

## List all coding agent terminals

```bash
osascript <<'APPLESCRIPT'
tell application "Ghostty"
  set agents to {"claude", "codex", "aider", "goose", "amp"}
  set out to ""

  repeat with t in terminals
    set tName to name of t
    repeat with a in agents
      if tName contains a then
        set out to out & a & tab & id of t & tab & tName & tab & working directory of t & linefeed
        exit repeat
      end if
    end repeat
  end repeat

  if out is "" then
    "No coding agents detected in any terminal."
  else
    out
  end if
end tell
APPLESCRIPT
```

## Find a specific agent type

```bash
# Find all Claude Code sessions
osascript -e '
tell application "Ghostty"
  set matches to every terminal whose name contains "claude"
  set out to ""
  repeat with t in matches
    set out to out & id of t & tab & name of t & tab & working directory of t & linefeed
  end repeat
  out
end tell'
```

## Detect idle vs busy agent

Most TUI agents change the terminal title or show activity indicators. A rough heuristic:

- If `name` is just the agent name (e.g., `claude`), the agent is likely at its prompt, waiting for input.
- If `name` includes additional context (e.g., a spinner, status, or subprocess), the agent is likely working.

This is imprecise — combine with timing (check `name` twice with a short delay) to detect if the title is changing, which suggests active work.

```bash
# Snapshot terminal names, wait, snapshot again — changed names are likely busy
osascript <<'APPLESCRIPT'
tell application "Ghostty"
  set matches to every terminal whose name contains "claude"
  set snapshot to {}

  repeat with t in matches
    set end of snapshot to {termId: id of t, termName: name of t}
  end repeat

  delay 2

  set out to ""
  repeat with i from 1 to count of snapshot
    set rec to item i of snapshot
    try
      set t to terminal id (termId of rec)
      set newName to name of t
      if newName is not (termName of rec) then
        set out to out & "BUSY " & termId of rec & tab & (termName of rec) & " → " & newName & linefeed
      else
        set out to out & "IDLE " & termId of rec & tab & newName & linefeed
      end if
    end try
  end repeat
  out
end tell
APPLESCRIPT
```

## Match agent to project

Cross-reference the agent's `working directory` with known project paths:

```bash
osascript -e '
tell application "Ghostty"
  set matches to every terminal whose name contains "claude" and working directory contains "yachiyo"
  if (count of matches) > 0 then
    set t to item 1 of matches
    "Found Claude Code in " & working directory of t & " (terminal " & id of t & ")"
  else
    "No Claude Code session found for yachiyo project"
  end if
end tell'
```
