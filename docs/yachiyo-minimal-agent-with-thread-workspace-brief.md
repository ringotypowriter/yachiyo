# Yachiyo Minimal Agent Brief

## Goal

Turn Yachiyo from chat into a real minimal agent by directly introducing the four core tools borrowed from pi-agent:

- `read`
- `write`
- `edit`
- `bash`

If these four tools do not exist and are not callable by the model, Yachiyo should not be considered an agent yet.

## Hard Decisions

### 1. Default execution style: YOLO

Yachiyo should default to YOLO execution.

That means:

- do not require per-step confirmation for normal tool calls
- do not introduce a heavy approval workflow in the first version
- prioritize speed and directness for a local single-user product

### 2. Per-thread workspace

Each thread should have its own workspace under `.yachiyo`.

Required rule:

- every thread gets a `temp-workspace` directory named by the thread snowflake id

Recommended path shape:

- `.yachiyo/temp-workspace/<threadSnowflakeId>/`

This directory is the default working directory for the agent in that thread.

That means:

- `bash` runs with `pwd` set to that thread workspace
- relative paths in `read` / `write` / `edit` should resolve from that workspace by default
- generated intermediate files belong to that thread workspace

Do not introduce an extra `/temp/` layer.
Do not overdesign workspace lifecycle in this round.
Just make the per-thread workspace real and usable.

### 3. Minimal safety floor for exec

Yachiyo should stay YOLO by default, but `bash` still needs a minimal hard safety floor.

The goal is not full sandboxing.
The goal is only to prevent obviously catastrophic commands from executing.

Required rule:

- clearly dangerous destructive commands must be refused before execution

Examples:

- `rm /`
- `rm -rf /`
- similar commands that target root or obvious system-critical locations

This safety layer only needs to be a simple first-pass guard.
If a command matches the deny rule, it must not run.

## Scope

### 1. Add the four agent tools

Implement model-callable tools for:

- `read`
- `write`
- `edit`
- `bash`

These should be real runtime tools, not just UI placeholders.

### 2. Connect tools to the existing run model

A tool call must happen inside the current thread/run model.

Desired behavior:

- a user sends a message in a thread
- the model may call one or more tools during that run
- tool results return to the model
- the assistant continues and produces a final answer

### 3. Record tool activity in the thread

Tool activity should not be hidden.

At minimum, Yachiyo should record enough information so the thread can reflect:

- which tool was called
- whether it succeeded or failed
- a short result summary
- for `bash`, the workspace / cwd used

### 4. Keep UI simple but visible

Do not build a heavy agent dashboard yet.

But the user should be able to tell:

- that a tool was called
- which tool it was
- whether it is running / completed / failed

## Tool Expectations

### `read`

Must be able to:

- read a file from the thread workspace or an explicit path
- return text content in a bounded way
- avoid dumping unbounded giant files in one shot

### `write`

Must be able to:

- create a new file
- overwrite a target file intentionally
- report success or failure clearly

### `edit`

Must be able to:

- modify an existing file without rewriting everything manually
- support a practical partial-edit path such as search/replace or patch-like editing

### `bash`

Must be able to:

- run shell commands with `pwd` set to the thread workspace
- return `stdout`
- return `stderr`
- return exit status
- refuse obviously catastrophic commands based on the safety floor

## Non-Goals For This Round

Do not spend this round on:

- plan mode
- sub-agents
- background bash
- MCP
- large permission systems
- complex sandboxing
- broad tool marketplaces
- advanced workspace management UI

## What Codex Should Decide

Codex should choose the implementation details for:

- how the four tools are exposed to the model
- how tool calls are represented in the current protocol
- how tool results are persisted into thread/run history
- where thread workspaces are created and when they are initialized
- how the destructive-command guard is implemented for `bash`

## Deliverable Expectation

When this round is done, Yachiyo should have crossed the line from chat app to minimal agent.

A thread should have:

- its own workspace
- a default agent working directory
- model-callable `read` / `write` / `edit` / `bash`
- YOLO execution by default
- a simple hard stop for obviously destructive shell commands
