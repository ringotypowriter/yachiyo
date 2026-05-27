# Recipe: Multi-Agent Coordination

Set up and coordinate multiple coding agents across Ghostty terminals — fan out tasks, monitor progress, and collect results.

## Launch a multi-agent workspace

Create a layout with multiple coding agents, each focused on a different part of the codebase:

```bash
osascript <<'APPLESCRIPT'
tell application "Ghostty"
  activate

  set projectDir to "/path/to/project"
  set cfg to new surface configuration
  set initial working directory of cfg to projectDir

  -- Window with 3 panes: one agent per area of concern
  set win to new window with configuration cfg
  set pane1 to terminal 1 of selected tab of win
  set pane2 to split pane1 direction right with configuration cfg
  set pane3 to split pane1 direction down with configuration cfg

  -- Launch agents (adjust commands to your agent of choice)
  input text "claude" to pane1
  send key "enter" to pane1

  input text "claude" to pane2
  send key "enter" to pane2

  input text "claude" to pane3
  send key "enter" to pane3
end tell
APPLESCRIPT
```

Wait a few seconds for agents to initialize before sending prompts.

## Fan out tasks to multiple agents

Send different prompts to different agent terminals:

```bash
osascript <<'APPLESCRIPT'
tell application "Ghostty"
  -- Assumes agents are already running; find them by cwd
  set allAgents to every terminal whose name contains "claude" and working directory contains "my-project"

  if (count of allAgents) < 3 then
    error "Expected 3 agents, found " & (count of allAgents)
  end if

  set a1 to item 1 of allAgents
  set a2 to item 2 of allAgents
  set a3 to item 3 of allAgents

  -- Agent 1: backend
  input text "review src/server/ for error handling issues and fix them" to a1
  send key "enter" to a1

  -- Agent 2: frontend
  input text "add loading states to all async components in src/components/" to a2
  send key "enter" to a2

  -- Agent 3: tests
  input text "write integration tests for the auth flow in src/auth/" to a3
  send key "enter" to a3
end tell
APPLESCRIPT
```

## Poll agent status

Periodically check which agents are still working vs idle:

```bash
osascript -e '
tell application "Ghostty"
  set agents to every terminal whose name contains "claude"
  set out to ""
  repeat with t in agents
    set tName to name of t
    set tCwd to working directory of t
    -- Heuristic: if name is just "claude" the agent is likely at its prompt
    -- If it contains more (subprocess, spinner chars), likely still working
    if length of tName > 10 then
      set out to out & "WORKING" & tab & id of t & tab & tName & tab & tCwd & linefeed
    else
      set out to out & "READY  " & tab & id of t & tab & tName & tab & tCwd & linefeed
    end if
  end repeat
  out
end tell'
```

This is a heuristic — adjust the threshold or pattern matching to your shell and agent setup.

## Collect and consolidate

After agents finish their tasks, you can ask each to summarize:

```bash
osascript <<'APPLESCRIPT'
tell application "Ghostty"
  set agents to every terminal whose name contains "claude"

  repeat with t in agents
    input text "summarize what you changed in one paragraph" to t
    send key "enter" to t
  end repeat
end tell
APPLESCRIPT
```

The orchestrating agent (Yachiyo) cannot read the output directly from the terminal buffer. To collect results programmatically, have each agent write its summary to a file:

```bash
osascript <<'APPLESCRIPT'
tell application "Ghostty"
  set agents to every terminal whose name contains "claude"
  set i to 1

  repeat with t in agents
    set outFile to "/tmp/agent-summary-" & i & ".md"
    input text ("write a summary of your changes to " & outFile) to t
    send key "enter" to t
    set i to i + 1
  end repeat
end tell
APPLESCRIPT
```

Then read the summary files from disk after agents complete.

## Mixed-agent coordination

Run different agent types for different strengths:

```bash
osascript <<'APPLESCRIPT'
tell application "Ghostty"
  activate
  set projectDir to "/path/to/project"
  set cfg to new surface configuration
  set initial working directory of cfg to projectDir

  set win to new window with configuration cfg
  set leftPane to terminal 1 of selected tab of win
  set rightPane to split leftPane direction right with configuration cfg

  -- Claude Code for architecture/refactoring
  input text "claude" to leftPane
  send key "enter" to leftPane

  -- Aider for targeted edits
  input text "aider --model gpt-4o" to rightPane
  send key "enter" to rightPane
end tell
APPLESCRIPT
```

## Teardown

Close all agent terminals when done:

```bash
osascript -e '
tell application "Ghostty"
  set agents to every terminal whose name contains "claude"
  repeat with t in agents
    -- Gracefully exit the agent first
    input text "/exit" to t
    send key "enter" to t
  end repeat
end tell'
```

Or force-close if agents are unresponsive:

```bash
osascript -e '
tell application "Ghostty"
  set agents to every terminal whose name contains "claude"
  repeat with t in agents
    send key "c" modifiers {control} to t
    delay 0.3
    send key "d" modifiers {control} to t
  end repeat
end tell'
```

## Coordination patterns summary

| Pattern          | Description                                           | When to use                             |
| ---------------- | ----------------------------------------------------- | --------------------------------------- |
| Fan-out          | Send different tasks to different agents              | Parallelize independent work            |
| Broadcast        | Send the same command to all agents                   | Sync, status check, or teardown         |
| Poll             | Periodically check agent `name` for status            | Wait for completion before next step    |
| File handoff     | Agent writes result to a file, orchestrator reads it  | Collect output despite no buffer access |
| Sequential relay | One agent finishes, then prompt the next with context | Dependent tasks (design → implement)    |
