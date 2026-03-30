# Recipe: Observe Agent Output

Since AppleScript cannot read the terminal screen buffer directly, use these workarounds to capture and observe what coding agents are producing.

## The core problem

Ghostty's AppleScript API exposes terminal **metadata** (name, working directory, ID) but not the **screen contents**. You cannot read what text is currently displayed in a terminal pane. This guide covers practical workarounds.

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

## Comparison of strategies

| Strategy       | Reliability | TUI-safe | Setup effort | Best for                          |
| -------------- | ----------- | -------- | ------------ | --------------------------------- |
| File handoff   | High        | Yes      | Low          | Collecting final results          |
| `tee` pipe     | High        | No*      | Low          | Full session logging              |
| `script`       | High        | Yes      | Low          | Full session recording            |
| Clipboard      | Low         | Yes      | None         | Quick one-off reads               |
| Git diff       | High        | Yes      | None         | Observing code changes            |
| Status prompt  | Medium      | Yes      | None         | Progress checks during long tasks |

\* `tee` may disable some TUI features depending on the agent.

## Recommended pattern for orchestration

For a Yachiyo agent coordinating other agents:

1. Launch agent with `script` to capture full output.
2. Use file handoff for structured intermediate results.
3. Use `git diff` as ground truth for code changes.
4. Use status prompts for progress monitoring.
5. Read transcript files or diffs from disk to understand what happened.
