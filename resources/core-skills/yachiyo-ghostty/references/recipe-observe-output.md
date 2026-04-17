# Recipe: Observe Agent Output

Since AppleScript cannot read the terminal screen buffer directly, use these workarounds to capture and observe what coding agents are producing.

## The core problem

Ghostty's AppleScript API exposes terminal **metadata** (name, working directory, ID) but not the **screen contents**. You cannot read what text is currently displayed in a terminal pane through AppleScript alone. This guide covers practical workarounds — including `screencapture` + image read, which sidesteps the buffer-read gap entirely when the agent can read images.

## Strategy 1: File-based handoff

Ask the agent to write its output to a known file, then read it from disk.

```bash
# Tell Claude Code to save its answer
osascript -e '
tell application "Ghostty"
  set t to terminal id "TARGET_ID"
  input text "write your analysis to /tmp/claude-output.md" to t
  send key "enter" to t
end tell'

# Wait, then read the file
sleep 10
cat /tmp/claude-output.md
```

For structured results, ask for JSON:

```bash
osascript -e '
tell application "Ghostty"
  set t to terminal id "TARGET_ID"
  input text "list all TODOs you found as JSON and save to /tmp/todos.json" to t
  send key "enter" to t
end tell'
```

## Strategy 2: Script output with `tee` or redirection

If you are launching the agent yourself, pipe output through `tee` from the start:

```bash
osascript -e '
tell application "Ghostty"
  set t to terminal id "TARGET_ID"
  input text "claude 2>&1 | tee /tmp/claude-session.log" to t
  send key "enter" to t
end tell'
```

Now the entire agent session is logged to `/tmp/claude-session.log`, readable at any time.

**Caveat**: This may break TUI rendering for some agents since piping through `tee` can disable interactive terminal features. Test first.

## Strategy 3: Use the `script` command

The `script` command records everything written to the terminal:

```bash
osascript -e '
tell application "Ghostty"
  set t to terminal id "TARGET_ID"
  input text "script -q /tmp/claude-transcript.txt claude" to t
  send key "enter" to t
end tell'
```

This creates a full transcript in `/tmp/claude-transcript.txt`. The file includes raw terminal escape codes — filter them for clean text:

```bash
# Strip ANSI escape codes from the transcript
sed 's/\x1b\[[0-9;]*[a-zA-Z]//g' /tmp/claude-transcript.txt > /tmp/claude-clean.txt
```

**Note**: `script` wraps the agent in a pseudo-terminal, so TUI functionality is preserved.

## Strategy 4: Clipboard relay

Ask the agent to copy its answer to the clipboard, then read it:

```bash
# Ask the agent to copy
osascript -e '
tell application "Ghostty"
  set t to terminal id "TARGET_ID"
  input text "copy your last response to the clipboard using pbcopy" to t
  send key "enter" to t
end tell'

# Read from clipboard
sleep 5
pbpaste
```

This is fragile but can work for short exchanges.

## Strategy 5: Git diff as output proxy

For coding agents that edit files, the output that matters is the code change — read it from git:

```bash
# After an agent finishes working
cd /path/to/project
git diff                    # Unstaged changes
git diff --cached           # Staged changes
git log --oneline -5        # Recent commits if agent committed
```

This is often the most reliable "observation" of what a coding agent actually did — the file changes are the ground truth.

## Strategy 6: Ask the agent to report status

Send a follow-up prompt asking the agent to summarize its state:

```bash
osascript -e '
tell application "Ghostty"
  set t to terminal id "TARGET_ID"
  input text "what is your current status? what have you done so far?" to t
  send key "enter" to t
end tell'
```

Combine with file handoff to capture the response:

```bash
osascript -e '
tell application "Ghostty"
  set t to terminal id "TARGET_ID"
  input text "write a brief status update to /tmp/agent-status.md" to t
  send key "enter" to t
end tell'
```

## Strategy 7: Screencapture + image read

If the agent has image-reading capability, this is the most direct way to "see" what is on a terminal pane — no cooperation from the running process required. It treats the terminal like any other GUI surface.

**Prerequisite**: Grant Screen Recording permission to the host process (Terminal/Ghostty/Yachiyo, whichever is invoking the agent) in `System Settings → Privacy & Security → Screen Recording`. The first `screencapture` call against another app's window will fail silently (produce a blank/desktop-only image) until this is granted.

### Capture a specific Ghostty window by window ID

Ghostty's AppleScript dictionary exposes `terminal` but not a raw window ID. Use `System Events` to bridge: focus the target terminal first, then grab the frontmost Ghostty window's ID.

```bash
# 1. Focus the target terminal so it becomes Ghostty's frontmost window
osascript -e '
tell application "Ghostty"
  focus terminal id "TARGET_ID"
end tell'

# 2. Get the AX window id of Ghostty's frontmost window
WIN_ID=$(osascript -e '
tell application "System Events"
  tell process "Ghostty"
    return value of attribute "AXWindowNumber" of window 1
  end tell
end tell')

# 3. Capture just that window (no shadow, no cursor)
screencapture -o -x -l "$WIN_ID" /tmp/ghostty-capture.png
```

Then read `/tmp/ghostty-capture.png` with whatever file/image read capability the agent has — the rendered terminal text comes through directly.

### Flags worth knowing

- `-l <windowid>` — capture a specific window by ID
- `-o` — omit the window drop shadow (cleaner crop)
- `-x` — no shutter sound
- `-R x,y,w,h` — capture a screen region (fallback when window ID is unavailable)
- `-t png|jpg` — output format (default png)

### When to use this

- You need to see **live TUI state** that is not logged anywhere (spinners, cursor position, current prompt contents before enter).
- You need to inspect an agent's output **without interrupting it** — no extra prompt, no file write.
- File handoff / `script` recording was not set up in advance and the session is already running.

### Caveats

- **Permission gate**: TCC prompt appears once; until granted, captures silently return a blank/desktop-only image. Verify by checking the PNG looks right the first time.
- **Only visible viewport**: `screencapture` grabs pixels, not scrollback. Anything scrolled off-screen is lost. Combine with "scroll the terminal to top" via `send key` if you need history.
- **Image-read cost**: Each capture is an image read. Prefer file handoff or `script` for long-running monitoring; reserve screencapture for targeted inspection.
- **Focus side-effect**: `focus terminal` brings the window forward and may disrupt the user's active window. If that matters, skip focus and capture by `-R` region against a known fixed layout instead.

## Comparison of strategies

| Strategy            | Reliability | TUI-safe | Setup effort | Best for                                 |
| ------------------- | ----------- | -------- | ------------ | ---------------------------------------- |
| File handoff        | High        | Yes      | Low          | Collecting final results                 |
| `tee` pipe          | High        | No\*     | Low          | Full session logging                     |
| `script`            | High        | Yes      | Low          | Full session recording                   |
| Clipboard           | Low         | Yes      | None         | Quick one-off reads                      |
| Git diff            | High        | Yes      | None         | Observing code changes                   |
| Status prompt       | Medium      | Yes      | None         | Progress checks during long tasks        |
| Screencapture+image | High        | Yes      | One-time TCC | Live TUI inspection without side effects |

\* `tee` may disable some TUI features depending on the agent.

## Recommended pattern for orchestration

For a Yachiyo agent coordinating other agents:

1. Launch agent with `script` to capture full output.
2. Use file handoff for structured intermediate results.
3. Use `git diff` as ground truth for code changes.
4. Use status prompts for progress monitoring.
5. Use screencapture + image read for live TUI inspection when the process is not logging and you cannot interrupt it.
6. Read transcript files, diffs, or PNGs from disk to understand what happened.
