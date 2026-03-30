# Ghostty AppleScript Reference

Complete API reference for controlling Ghostty via AppleScript. Based on [ghostty-org/ghostty#11208](https://github.com/ghostty-org/ghostty/pull/11208).

## Object Model

```
application "Ghostty"
├── windows          (window objects)
│   ├── tabs         (tab objects)
│   │   └── terminals (terminal objects)
│   └── selected tab
└── terminals        (flat list of all terminals across all windows)
```

### Object Properties

| Object      | Property            | Type    | Description                          |
| ----------- | ------------------- | ------- | ------------------------------------ |
| application | name                | text    | App name ("Ghostty")                 |
| application | frontmost           | boolean | Whether Ghostty is the active app    |
| application | version             | text    | Ghostty version string               |
| window      | id                  | text    | Unique window identifier             |
| window      | name                | text    | Window title                         |
| window      | selected tab        | tab     | Currently active tab                 |
| tab         | id                  | text    | Unique tab identifier                |
| tab         | name                | text    | Tab title                            |
| tab         | index               | integer | Tab position (1-based)               |
| tab         | selected            | boolean | Whether this tab is active           |
| terminal    | id                  | text    | Unique terminal surface identifier   |
| terminal    | name                | text    | Terminal title (usually the process) |
| terminal    | working directory   | text    | Current working directory (POSIX)    |

## Commands

### Discovery & Navigation

#### List all terminals (flat)

```applescript
tell application "Ghostty"
  set allTerms to terminals
  repeat with t in allTerms
    log (id of t & " | " & name of t & " | " & working directory of t)
  end repeat
end tell
```

#### List window → tab → terminal hierarchy

```applescript
tell application "Ghostty"
  repeat with w in windows
    log ("Window: " & id of w & " — " & name of w)
    repeat with tb in tabs of w
      log ("  Tab " & index of tb & ": " & name of tb)
      repeat with t in terminals of tb
        log ("    Terminal: " & id of t & " | " & name of t & " | cwd: " & working directory of t)
      end repeat
    end repeat
  end repeat
end tell
```

#### Find terminals by working directory

```applescript
tell application "Ghostty"
  set matches to every terminal whose working directory contains "my-project"
  -- returns a list; iterate or take item 1
end tell
```

#### Find terminals by name (running process)

```applescript
tell application "Ghostty"
  set matches to every terminal whose name contains "python"
end tell
```

#### Focus a terminal

```applescript
tell application "Ghostty"
  focus terminal id "TERMINAL_ID"
end tell
```

#### Activate a window (bring to front)

```applescript
tell application "Ghostty"
  activate window id "WINDOW_ID"
end tell
```

#### Select a tab

```applescript
tell application "Ghostty"
  select tab id "TAB_ID"
end tell
```

### Input

#### Send text (paste-style)

```applescript
tell application "Ghostty"
  input text "echo hello" to terminal id "TERMINAL_ID"
end tell
```

This inserts text as if pasted — it does **not** press Enter. Combine with `send key` to execute.

#### Send a key press

```applescript
tell application "Ghostty"
  send key "enter" to terminal id "TERMINAL_ID"
end tell
```

Modifier keys can be combined:

```applescript
send key "c" modifiers {control} to terminal id "TERMINAL_ID"  -- Ctrl+C
send key "d" modifiers {control} to terminal id "TERMINAL_ID"  -- Ctrl+D (EOF)
send key "z" modifiers {control} to terminal id "TERMINAL_ID"  -- Ctrl+Z (suspend)
send key "l" modifiers {control} to terminal id "TERMINAL_ID"  -- Ctrl+L (clear)
```

#### Run a command (input + enter)

```applescript
tell application "Ghostty"
  set t to terminal id "TERMINAL_ID"
  input text "ls -la" to t
  send key "enter" to t
end tell
```

### Window & Layout Management

#### Create a new window

```applescript
tell application "Ghostty"
  set win to new window
end tell
```

With a custom working directory:

```applescript
tell application "Ghostty"
  set cfg to new surface configuration
  set initial working directory of cfg to "/path/to/project"
  set win to new window with configuration cfg
end tell
```

#### Create a new tab

```applescript
tell application "Ghostty"
  set tb to new tab in window 1
end tell
```

#### Split a terminal

```applescript
tell application "Ghostty"
  set t to terminal 1 of selected tab of window 1
  set newT to split t direction right   -- or: down, left, up
end tell
```

With configuration:

```applescript
tell application "Ghostty"
  set cfg to new surface configuration
  set initial working directory of cfg to "/tmp"
  set t to terminal 1 of selected tab of window 1
  set newT to split t direction down with configuration cfg
end tell
```

#### Close terminals, tabs, windows

```applescript
tell application "Ghostty"
  close terminal id "TERMINAL_ID"
  close tab id "TAB_ID"
  close window id "WINDOW_ID"
end tell
```

### Perform Ghostty Actions

Execute any Ghostty action string on a terminal:

```applescript
tell application "Ghostty"
  perform action "toggle_fullscreen" on terminal id "TERMINAL_ID"
end tell
```

### Surface Configuration

Reusable configuration for new windows, tabs, or splits:

```applescript
tell application "Ghostty"
  set cfg to new surface configuration
  set initial working directory of cfg to "/path/to/dir"
  -- use cfg with: new window, new tab, or split
end tell
```

Copy from an existing terminal:

```applescript
tell application "Ghostty"
  set cfg to new surface configuration from terminal id "TERMINAL_ID"
  -- cfg inherits the source terminal's settings
end tell
```

## Practical Recipes

### Monitor: What is running in each terminal?

```bash
osascript -e '
tell application "Ghostty"
  set out to ""
  set allTerms to terminals
  repeat with t in allTerms
    set out to out & id of t & tab & name of t & tab & working directory of t & linefeed
  end repeat
  out
end tell'
```

The `name` property typically reflects the foreground process (e.g., `vim`, `python`, `cargo build`).

### Monitor: Find idle terminals

Terminals whose name matches their shell (e.g., `fish`, `zsh`, `bash`) are likely idle:

```bash
osascript -e '
tell application "Ghostty"
  set idle to every terminal whose name contains "fish"
  repeat with t in idle
    log (id of t & " idle at " & working directory of t)
  end repeat
end tell'
```

### Send Ctrl+C to interrupt a process

```bash
osascript -e '
tell application "Ghostty"
  send key "c" modifiers {control} to terminal id "TARGET_ID"
end tell'
```

### Broadcast a command to all terminals

```bash
osascript -e '
tell application "Ghostty"
  set cmd to "echo synced at $(date)"
  repeat with t in terminals
    input text cmd to t
    send key "enter" to t
  end repeat
end tell'
```

### Create a dev layout (editor + build + logs)

```bash
osascript <<'APPLESCRIPT'
tell application "Ghostty"
  activate

  set cfg to new surface configuration
  set initial working directory of cfg to "/path/to/project"

  set win to new window with configuration cfg
  set editor to terminal 1 of selected tab of win
  set build to split editor direction right with configuration cfg
  set logs to split build direction down with configuration cfg

  input text "nvim ." to editor
  send key "enter" to editor

  input text "# build pane ready" to build
  send key "enter" to build

  input text "tail -f /tmp/app.log" to logs
  send key "enter" to logs

  focus editor
end tell
APPLESCRIPT
```

### Jump to a project terminal

```bash
osascript -e '
tell application "Ghostty"
  set matches to every terminal whose working directory contains "my-project"
  if (count of matches) > 0 then
    focus (item 1 of matches)
  else
    display dialog "No terminal found for my-project"
  end if
end tell'
```

## Troubleshooting

| Problem | Cause | Fix |
| ------- | ----- | --- |
| "Ghostty got an error: AppleScript is not enabled" | Config `macos-applescript = false` | Set `macos-applescript = true` in Ghostty config |
| macOS permission dialog keeps appearing | TCC prompt for automation | Grant permission in System Settings > Privacy > Automation |
| Terminal ID not found | Terminal was closed or ID is stale | Re-list terminals to get fresh IDs |
| `name` is empty or generic | Terminal title not set by shell | Check shell integration / `PROMPT_COMMAND` setup |
| `working directory` is empty | Shell integration not reporting CWD | Enable Ghostty shell integration or set `OSC 7` in shell config |
