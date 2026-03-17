# Handoff — Yachiyo Agent Tools

## Current Direction

This thread converged on a clear next step for Yachiyo:

- Yachiyo should become a real minimal agent, not just a chat app with vague tool hooks.
- The minimum bar is the four `pi`-style tools: `read`, `write`, `edit`, `bash`.
- Default execution style should be `YOLO`.
- Each thread should use its own workspace at:
  - `.yachiyo/temp-workspace/<threadSnowflakeId>/`
- The agent `pwd` should default to that thread workspace.
- `bash` should keep only a thin hard safety floor for obviously catastrophic commands like `rm -rf /`.

## Briefs Written

Two docs were created in this thread:

- `docs/yachiyo-minimal-agent-with-thread-workspace-brief.md`
  - product / roadmap brief
  - defines the four-tool baseline, YOLO default, per-thread workspace, and minimal bash guard

- `docs/yachiyo-agent-tool-contract-brief.md`
  - technical brief
  - specifically targets `tool schema`, `runtime contract`, `structured results`, `cwd-bound tool instances`, and `pi-mono`-style semantics

## Important Finding About pi-mono

I inspected the real `pi-mono` source locally under `/tmp/pi-mono`.
The useful references were:

- `/tmp/pi-mono/packages/coding-agent/src/core/tools/index.ts`
- `/tmp/pi-mono/packages/coding-agent/src/core/tools/read.ts`
- `/tmp/pi-mono/packages/coding-agent/src/core/tools/write.ts`
- `/tmp/pi-mono/packages/coding-agent/src/core/tools/edit.ts`
- `/tmp/pi-mono/packages/coding-agent/src/core/tools/bash.ts`
- `/tmp/pi-mono/packages/agent/src/types.ts`
- `/tmp/pi-mono/packages/agent/src/agent-loop.ts`

Key takeaways:

- `pi` really does center the minimal toolset on `read/write/edit/bash`.
- Tool instances are created with a bound `cwd`.
- Tool results are not just `ok/error`; they are closer to:
  - `content`
  - `details`
  - error state handled separately
- The loop supports tool lifecycle events and structured tool result messages.
- `read` uses `path + offset + limit` semantics.
- `edit` is centered on `path + oldText + newText` and returns diff-oriented metadata.
- `bash` is closer to a real agent runtime than Yachiyo's current coarse version:
  - supports abort signal
  - streams/updates
  - truncates tail output
  - keeps metadata for truncation and full output path
- I did **not** find the kind of destructive command denylist in pi itself that Yachiyo now wants; that is a Yachiyo-specific policy layer.

## Current Yachiyo State In Repo

The repo already has a first-pass tool implementation and protocol surface.
Useful files:

- `src/main/yachiyo-server/agentTools.ts`
- `src/main/yachiyo-server/YachiyoServer.ts`
- `src/main/yachiyo-server/modelRuntime.ts`
- `src/shared/yachiyo/protocol.ts`
- `src/main/yachiyo-server/agentTools.test.ts`
- `src/main/yachiyo-server/server.test.ts`

Current state is roughly:

- there is already a coarse four-tool implementation
- there is already tool persistence / timeline plumbing
- there is already thread workspace usage in the server path
- but the tool contract is still too toy-like compared with `pi-mono`

Main gap:

- outputs are still mostly ad-hoc `ok/error` objects in `src/main/yachiyo-server/agentTools.ts`
- schema and result design do not yet match pi-style runtime semantics closely enough

## What The Next Thread Should Do

Use `docs/yachiyo-agent-tool-contract-brief.md` as the main implementation target.

The next Codex pass should focus on:

- refactoring `src/main/yachiyo-server/agentTools.ts`
- making the tool contract less `ok/error blob`-like
- moving `read` toward `offset/limit` continuation semantics
- moving `edit` toward `oldText/newText` with diff metadata
- making `bash` closer to pi-style execution semantics
- keeping Yachiyo-specific policy for catastrophic bash command blocking
- evolving `src/shared/yachiyo/protocol.ts` so tool records can hold richer details later

## One Small Note

The technical brief currently contains a tiny typo in the `edit` section of `docs/yachiyo-agent-tool-contract-brief.md`:

- there is a stray `n` before `first changed line if practical`

It is minor, but worth cleaning when continuing.
