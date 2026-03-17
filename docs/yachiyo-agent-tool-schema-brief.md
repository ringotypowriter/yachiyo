# Yachiyo Agent Tool Schema Brief

## Goal

Refine the current Yachiyo agent tool layer so it is closer to the real `pi-mono` design, not just a coarse local approximation.

This brief is specifically about:

- tool schema
- tool runtime contract
- tool result shape
- workspace / cwd semantics
- event and persistence mapping
- where Yachiyo should intentionally diverge from pi

This is not a product UX brief.
This is a technical contract brief for Codex.

## Current Situation

Yachiyo already has a first pass of the four tools in `src/main/yachiyo-server/tools/agentTools.ts` and the shared protocol already knows about:

- `read`
- `write`
- `edit`
- `bash`

Relevant files already in place:

- `src/main/yachiyo-server/tools/agentTools.ts`
- `src/shared/yachiyo/protocol.ts`
- `src/main/yachiyo-server/app/YachiyoServer.ts`
- `src/main/yachiyo-server/runtime/modelRuntime.ts`

But the current version is still rough compared with real `pi-mono`:

- result shapes are Yachiyo-specific and too ad hoc
- `read` is much simpler than pi's bounded read model
- `edit` is simpler and lacks diff-oriented details
- `bash` is not yet modeled like a streaming-capable tool contract
- tool execution is currently wired through AI SDK callbacks, but the internal contract should become more explicit and durable

## What To Take From Real pi-mono

Codex should align with the actual pi design principles below.

### 1. Tools are instantiated with a cwd

In pi, the coding tools are created per working directory, not as floating global functions.

Yachiyo should preserve the same idea:

- each run gets tools bound to the current thread workspace
- the thread workspace is the default base for relative file paths
- `bash` runs with `cwd` set to that workspace

For Yachiyo, that means:

- continue using per-thread workspace binding
- the workspace path should remain `.yachiyo/temp-workspace/<threadSnowflakeId>/`

### 2. Every tool has a schema and a structured result

In pi-agent-core, tools are not just function names.
They have:

- name
- label
- description
- parameter schema
- execute contract
- structured result

Yachiyo does not need to reimplement pi-agent-core itself, but it should copy the same discipline.

### 3. Tool results are not just strings

In pi, a tool returns structured content plus structured details.
That is the main thing Yachiyo should move closer to.

For Yachiyo, tool outputs should stop being only "ok + some fields" blobs used ad hoc by summaries.
Instead, each tool output should clearly separate:

- model-visible content
- machine-readable details
- execution metadata

### 4. Tool execution is part of the run log

Pi turns tool execution into first-class agent events and writes final tool results back into the message flow.

Yachiyo already has a good start here with:

- `tool.updated`
- persisted `ToolCallRecord`
- timeline rendering

The next step is to make the internal tool contract strong enough that this logging is derived from the tool model, not from fragile summary logic.

## Required Target Contract

Codex should refactor the current tool layer toward this internal shape.

## Internal Tool Definition

Yachiyo should have an internal server-side tool definition shape similar to:

```ts
interface YachiyoAgentTool<TInput, TDetails> {
  name: 'read' | 'write' | 'edit' | 'bash'
  description: string
  inputSchema: ZodSchema<TInput>
  execute(input: TInput, context: YachiyoToolContext): Promise<YachiyoToolResult<TDetails>>
}

interface YachiyoToolContext {
  workspacePath: string
  abortSignal?: AbortSignal
}

interface YachiyoToolResult<TDetails> {
  ok: boolean
  content: string
  details: TDetails
  metadata?: {
    cwd?: string
    blocked?: boolean
    timedOut?: boolean
    exitCode?: number
  }
  error?: string
}
```

The exact type names can differ.
But the separation of:

- input schema
- execute contract
- content
- details
- metadata

should be explicit.

## Tool-Specific Requirements

### `read`

Yachiyo should move closer to pi's bounded read semantics.

Input schema should become:

```ts
{
  path: string
  offset?: number
  limit?: number
}
```

Not:

```ts
{
  path: string
  startLine?: number
  lineCount?: number
  maxChars?: number
}
```

Why:

- pi uses `offset` + `limit` as the continuation model
- this produces a simpler tool contract for models
- it is easier to keep stable across runtimes and UI surfaces

Required read behavior:

- resolve relative paths from thread workspace
- allow explicit absolute paths if current Yachiyo policy still allows them
- read text files in bounded form
- return a continuation hint when truncated
- avoid dumping giant files at once

Recommended result shape:

```ts
interface ReadToolDetails {
  path: string
  startLine: number
  endLine: number
  totalLines: number
  truncated: boolean
}
```

The human-facing `content` should be the actual excerpt plus continuation hint.
The structured `details` should carry the numbers.

Yachiyo does not need to copy pi's image-reading behavior in this round.
Image input already exists elsewhere in the chat model.
Do not let this brief expand `read` into multimodal file ingestion unless there is already a clean path.

### `write`

Pi's `write` is simple:

- `path`
- `content`
- creates parent directories
- overwrites existing file

Yachiyo currently adds `overwrite?: boolean`.
That is a reasonable local divergence if you want slightly safer behavior than pi.

So for Yachiyo, keep this input schema if desired:

```ts
{
  path: string
  content: string
  overwrite?: boolean
}
```

But refactor the result contract so it is less ad hoc.

Recommended details:

```ts
interface WriteToolDetails {
  path: string
  bytesWritten: number
  created: boolean
  overwritten: boolean
}
```

And the model-facing `content` should be a short success or failure message.

### `edit`

Pi's `edit` is not a full patch engine.
It is basically:

- `path`
- `oldText`
- `newText`

with targeted replacement semantics and diff-style details.

Yachiyo currently adds `replaceAll?: boolean`.
That is acceptable, but the result needs to become richer.

Required behavior:

- read file
- ensure the match is either unique or intentionally `replaceAll`
- write the updated file
- return a structured diff-oriented result

Recommended details:

```ts
interface EditToolDetails {
  path: string
  replacements: number
  diff?: string
  firstChangedLine?: number
}
```

Yachiyo does not need fuzzy matching unless Codex thinks it is worth the complexity.
But Yachiyo should at least produce:

- replacements count
- diff string when practical
- a stable failure reason when match is missing or ambiguous

That will make timeline summaries and future UI much better.

### `bash`

This is the most important one to tighten.

Pi's real bash tool has several important properties:

- schema is just `command` plus optional timeout
- execution is bound to `cwd`
- stdout and stderr are streamed together into the rolling output model
- output is truncated in a bounded way
- full output may be written to a temp file when too large
- abort and timeout are first-class
- the tool contract can emit partial updates

Yachiyo does not need to fully clone pi's streaming bash immediately.
But the contract should be refactored so it can grow there cleanly.

Input schema should become closer to pi:

```ts
{
  command: string
  timeout?: number
}
```

Use seconds, not `timeoutMs`.
This is closer to pi and easier for models.

Required behavior:

- run inside thread workspace
- capture stdout
- capture stderr
- capture exit code
- support abort signal
- support timeout
- block obviously catastrophic commands before spawn

Recommended details:

```ts
interface BashToolDetails {
  command: string
  cwd: string
  exitCode?: number
  stdout: string
  stderr: string
  truncated?: boolean
  timedOut?: boolean
  blocked?: boolean
}
```

The model-facing `content` should be a bounded textual output block.
The structured `details` should hold the real fields.

Important divergence from pi:

- pi appears to run much closer to pure YOLO and does not obviously ship the exact destructive-command guard Yachiyo wants
- Yachiyo should keep its local guardrail for `rm /` style commands

That guard should remain minimal and explicit.
Do not turn this into a broad policy engine.

## Event and Persistence Contract

The current shared protocol already has a useful external shape in `src/shared/yachiyo/protocol.ts`.
Do not redesign it unless necessary.

Keep:

- `ToolCallRecord`
- `tool.updated`
- timeline-oriented summaries

But make the persistence mapping derive from the new structured result contract.

That means:

- `inputSummary` comes from a tool-specific summarizer over validated input
- `outputSummary` comes from a tool-specific summarizer over structured result
- `cwd` should come from tool metadata, not from brittle output inspection
- failure state should come from `ok` / metadata / error, not from guesswork

In particular:

- stop extracting bash cwd by parsing result shape indirectly if a direct metadata field can carry it
- prefer a single normalization layer from `YachiyoToolResult` into `ToolCallRecord`

## AI SDK Integration

Yachiyo currently exposes tools through AI SDK `tool(...)` definitions in `src/main/yachiyo-server/tools/agentTools.ts`.
That is fine.
Do not replace AI SDK just to imitate pi-agent-core.

But the AI SDK-facing tool wrappers should become thin adapters over the stronger internal tool contract.

Recommended split:

- pure internal tool implementations
- AI SDK wrapper layer
- tool result -> storage/event normalization layer

This will make the code much easier to evolve.

## Workspace Semantics

Keep the current Yachiyo decision:

- thread workspace path: `.yachiyo/temp-workspace/<threadSnowflakeId>/`
- relative file paths resolve from there
- `bash` starts there

Codex should make sure this workspace path is treated as a first-class field in the tool context, not scattered path plumbing.

## Non-Goals

Do not spend this round on:

- sub-agents
- plan mode
- MCP
- tool marketplaces
- full sandboxing
- image support inside `read`
- generic attachment tools

## Codex Deliverable

When done, the result should be:

- the four tools still exist: `read`, `write`, `edit`, `bash`
- their schemas are closer to real pi where appropriate
- their results use a stronger internal contract
- `bash` uses `timeout` in seconds and keeps the YOLO + minimal guard model
- tool persistence and timeline summaries derive from structured result data instead of rough ad hoc blobs
- `src/main/yachiyo-server/tools/agentTools.ts` becomes noticeably cleaner and less coarse
