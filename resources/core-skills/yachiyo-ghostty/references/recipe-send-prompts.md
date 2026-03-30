# Recipe: Send Prompts to TUI Coding Agents

Send prompts, commands, and key sequences to coding agents running in Ghostty terminals.

## How TUI agent input works

TUI coding agents (Claude Code, Codex, Aider, etc.) read from stdin via a terminal UI. To interact with them:

1. **`input text`** — types text into the terminal as if pasted (does not press Enter)
2. **`send key "enter"`** — submits the prompt
3. **`send key` with modifiers** — sends control sequences (Ctrl+C to cancel, Escape to dismiss, etc.)

## Send a prompt to Claude Code

```bash
osascript <<'APPLESCRIPT'
tell application "Ghostty"
  -- Find the Claude Code session in the target project
  set matches to every terminal whose name contains "claude" and working directory contains "my-project"
  if (count of matches) = 0 then error "No Claude Code terminal found"

  set t to item 1 of matches
  focus t

  -- Type the prompt (paste-style, instant)
  input text "explain the authentication flow in src/auth/" to t
  -- Submit it
  send key "enter" to t
end tell
APPLESCRIPT
```

## Send a prompt to Codex

Codex CLI works similarly — it reads multiline input from the terminal:

```bash
osascript -e '
tell application "Ghostty"
  set matches to every terminal whose name contains "codex"
  if (count of matches) = 0 then error "No Codex terminal found"
  set t to item 1 of matches
  input text "refactor the database module to use connection pooling" to t
  send key "enter" to t
end tell'
```

## Send a prompt to Aider

Aider uses a `/` command prefix for special commands and bare text for prompts:

```bash
osascript -e '
tell application "Ghostty"
  set matches to every terminal whose name contains "aider"
  if (count of matches) = 0 then error "No Aider terminal found"
  set t to item 1 of matches
  input text "/add src/utils.ts" to t
  send key "enter" to t
  delay 0.5
  input text "add input validation to the parseConfig function" to t
  send key "enter" to t
end tell'
```

## Agent control sequences

Common key sequences for controlling TUI agents:

```bash
# Cancel current operation (Ctrl+C)
osascript -e '
tell application "Ghostty"
  set t to terminal id "TARGET_ID"
  send key "c" modifiers {control} to t
end tell'

# Escape (dismiss menus, cancel input)
osascript -e '
tell application "Ghostty"
  set t to terminal id "TARGET_ID"
  send key "escape" to t
end tell'

# Accept a suggestion / confirm (Enter)
osascript -e '
tell application "Ghostty"
  set t to terminal id "TARGET_ID"
  send key "enter" to t
end tell'
```

### Agent-specific key bindings

| Action             | Claude Code     | Codex        | Aider           |
| ------------------ | --------------- | ------------ | --------------- |
| Submit prompt      | Enter           | Enter        | Enter           |
| Cancel generation  | Escape          | Ctrl+C       | Ctrl+C          |
| Accept all changes | y + Enter       | y + Enter    | y + Enter       |
| Reject changes     | n + Enter       | n + Enter    | n + Enter       |
| Exit agent         | /exit or Ctrl+D | Ctrl+C twice | /exit or Ctrl+D |
| Clear context      | /clear          | —            | /clear          |

## Multiline prompts

For longer prompts, use newline characters. Most TUI agents treat pasted newlines as part of the same message:

```bash
osascript <<'APPLESCRIPT'
tell application "Ghostty"
  set t to terminal id "TARGET_ID"
  set prompt to "Review the following files for security issues:" & linefeed & ¬
    "1. src/auth/login.ts" & linefeed & ¬
    "2. src/api/middleware.ts" & linefeed & ¬
    "Focus on input validation and SQL injection."
  input text prompt to t
  send key "enter" to t
end tell
APPLESCRIPT
```

**Caution**: Some agents may interpret pasted newlines as immediate submission. Test with a short message first.

## Safety guidelines

- **Always find and focus the correct terminal first** — sending a prompt to the wrong terminal could execute unintended commands in a shell.
- **Verify the terminal `name` contains the agent process** before sending input — if the agent exited, you would be typing into a raw shell.
- **Do not blindly accept changes** (sending `y + Enter`) without the user's awareness — always inform the user what you are about to approve.
- **Prefer focus + input over blind input** — focusing first ensures the correct terminal receives keystrokes.
