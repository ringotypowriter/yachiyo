# Yachiyo Agent Tool Contract Brief

## Goal

Refactor the current coarse tool layer in `src/main/yachiyo-server/agentTools.ts` to follow the real `pi-mono` design more closely.

The target is not just "four tools exist".
The target is:

- strict tool schemas
- cwd-bound tool instances
- structured tool results
- streaming-capable execution shape
- tool lifecycle visibility
- thread workspace as the default execution root

## Files To Rework

- `src/main/yachiyo-server/agentTools.ts`
- `src/main/yachiyo-server/YachiyoServer.ts`
- `src/main/yachiyo-server/modelRuntime.ts`
- `src/shared/yachiyo/protocol.ts`

## Product Constraints

- keep the four core tools: `read`, `write`, `edit`, `bash`
- default execution remains YOLO
- each thread uses `.yachiyo/temp-workspace/<threadSnowflakeId>/` as default cwd
- keep a minimal hard block for obviously catastrophic bash commands

## What Is Wrong In The Current Version

The current implementation is functional but too coarse:

- tool outputs are mostly ad-hoc `ok/error` objects
- schemas do not match pi-style semantics closely enough
- `read` is too shallow and not continuation-friendly
- `edit` is too simplistic and loses useful diff metadata
- `bash` output handling is too flat and not event/update oriented
- the contract between tool execution and run history is under-specified

## Required Contract

### 1. Unified tool shape

Each tool should conceptually return:

- `content`: model-consumable result blocks
- `details`: structured UI/log payload
- error state separate from normal result content

Do not keep the design centered on `ok: boolean` blobs.
Move closer to a pi-style result contract.

### 2. Tool instance bound to cwd

Do not treat tools as global helpers.
Create the toolset from a thread workspace:

- `createAgentToolSet({ workspacePath })`
- all relative paths resolve from that workspace
- `bash` runs with that workspace as cwd

### 3. Lifecycle shape

Tool execution should support these phases:

- start
- optional update
- end

Even if only `bash` truly streams updates in the first pass, the contract should allow partial updates.

### 4. Tool result must be persistable

A tool result must cleanly support:

- model continuation
- thread timeline summary
- persistence to storage
- failure reporting

## Tool-Specific Requirements

### `read`

Match pi semantics more closely:

- schema: `path`, optional `offset`, optional `limit`
- support bounded continuation instead of `startLine/lineCount/maxChars`
- default truncation should be line-based and byte-based
- return continuation hints when truncated
- details should carry truncation metadata

### `write`

Keep it simple:

- schema: `path`, `content`
- create parent directories automatically
- overwrite is allowed by default for now if you want pi parity
- result details should include bytes written and created/overwritten state

If Ringo's earlier overwrite safeguard conflicts with pi parity, prefer matching pi semantics in the core contract and keep any stricter behavior as a Yachiyo-specific policy layer.

### `edit`

Move toward pi semantics:

- schema: `path`, `oldText`, `newText`
- default mental model is targeted replacement, not generic patching
- must reject zero-match and ambiguous multi-match cases
- details should include at least:
  - unified diff
    n - first changed line if practical

Do not keep `replaceAll` as the main interaction model unless there is a very strong reason.

### `bash`

Match pi much more closely:

- schema: `command`, optional `timeout`
- cwd is always the thread workspace
- support abort signal
- capture stdout and stderr together for model-facing output behavior
- keep bounded tail output for the model
- if output is truncated, preserve metadata about truncation
- if practical, keep a full-output temp file path in details
- keep Yachiyo's minimal catastrophic-command block as a pre-execution guard

## Protocol Direction

`src/shared/yachiyo/protocol.ts` should be upgraded so tool activity can evolve beyond simple summaries.

At minimum, tool call records should be able to represent:

- tool name
- status
- input summary
- output summary
- cwd
- started/finished timestamps
- error
- optional structured details snapshot

Do not overdesign the renderer yet, but do not freeze the protocol into a summary-only dead end.

## Runtime Direction

`YachiyoServer` should keep using the current run/thread model, but the tool bridge should feel more like a real agent loop:

- tool start is recorded immediately
- tool finish updates the same record
- failures and cancellations finalize pending tool calls cleanly
- workspace path is always explicit at toolset construction time

## Deliverable Expectation

When this refactor is done, Yachiyo should still have only four tools, but their contract should be much less toy-like.

Codex should optimize for:

- pi-style schema discipline
- better result structure
- better truncation behavior
- better edit metadata
- bash execution semantics that are closer to a real agent runtime
