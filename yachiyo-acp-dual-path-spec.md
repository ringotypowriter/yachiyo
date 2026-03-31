# Yachiyo ACP Dual-Path Spec

## Goal

Add ACP as a first-class capability in Yachiyo through two parallel product paths:

- **Direct chat with agent**: the active thread talks directly to an ACP-backed agent
- **Delegate task to agent**: a normal Yachiyo run invokes an ACP-backed agent as a worker

These two paths must share one ACP backbone. They must not become two separate stacks.

The target is not just “ACP works somewhere”.
The target is:

- ACP can be selected from the chat experience like a backend choice
- ACP can still be used as a delegated coding worker
- both paths reuse the same spawning, session, permission, and streaming machinery
- the UX stays clear about which path is active

## Product Decision

### 1. One shared ACP platform, two entry points

Yachiyo should have exactly one ACP integration layer, reused by:

- the **ACP Chat Runtime**
- the **ACP Delegate Runtime**

The delegate tool remains valid.
Direct ACP chat becomes a second, parallel feature.

### 2. In ACP chat mode, thread equals session

For direct ACP chat, the correct mental model is:

```text
Yachiyo Thread = ACP Session
```

More precisely:

- the **Yachiyo thread** remains the product container, transcript owner, and UI anchor
- the **ACP session** is the live backend state behind that thread

This means:

- the first user turn in an ACP chat thread creates a new ACP session
- later turns in the same ACP chat thread resume the same ACP session
- Yachiyo stores the ACP session id as part of thread state

### 3. ACP should feel model-like in UI, but not be implemented as a fake model

Users should be able to pick ACP agents from the same general place where they pick models.

But implementation must **not** force ACP into the existing AI SDK language-model path.

Reason:

- the current model path is request/reply oriented
- ACP is session oriented
- ACP has its own lifecycle, resume semantics, permission events, and opaque internal state

So the correct design is:

- **model-like selection in the UI**
- **runtime-like branching in the backend**

### 4. Direct ACP chat and delegated ACP work are different user experiences

They must stay separate at the UX level:

- **Direct ACP chat** means the agent is the main speaker for that thread
- **Delegation** means Yachiyo is still the main speaker and temporarily uses an ACP worker

Do not collapse these into one ambiguous feature.

## User Stories

### Direct ACP chat

- A user opens the model/agent picker, chooses an ACP agent, and starts chatting.
- The thread header clearly indicates that this thread is backed by an agent, not a normal model.
- Follow-up messages continue the same ACP session.
- Cancel stops the current run without destroying the thread.
- Reopening the app should allow the next turn to resume the same ACP session when possible.

### Delegated ACP work

- A user stays in a normal Yachiyo model thread.
- Yachiyo decides to call `delegateCodingTask`.
- The ACP agent runs as a worker and returns a result summary plus session id.
- Yachiyo reviews the result and replies to the user.

## Scope

### In scope

- shared ACP platform
- direct ACP chat threads
- delegated ACP work using the same ACP platform
- ACP agent selection from chat UI
- thread-level ACP session persistence
- run cancellation
- resume of ACP sessions on later turns
- basic ACP-specific status in the UI

### Out of scope for v1

- exact replay of ACP chat threads from transcript alone
- retrying old ACP turns with guaranteed equivalence
- editing older user turns in ACP chat threads
- exact branch/fork semantics for ACP sessions
- merging Yachiyo tool calls into ACP chat as if both systems were one tool loop
- image-native ACP chat unless the ACP provider explicitly supports it

## Existing Yachiyo Facts To Preserve

The current codebase already has:

- local thread/run/message/tool-call architecture
- thread workspaces
- settings-driven ACP profiles
- an ACP-backed `delegateCodingTask` implementation

The new design must preserve these realities:

- a thread is still the main unit in the product
- event streaming remains the main UI contract
- the current AI SDK model runtime remains intact for normal providers
- delegated ACP execution still exists after direct ACP chat is added

## Architecture

## 1. Shared ACP Backbone

Introduce a dedicated ACP platform module, for example under:

```text
src/main/yachiyo-server/runtime/acp/
```

This ACP platform owns:

- profile resolution
- process spawning
- login-shell environment merge
- ACP connection initialization
- session creation
- session resume
- permission auto-approval
- session cancellation
- output streaming
- final message extraction
- process cleanup

Recommended internal services:

- `acpProfileRegistry.ts`
- `acpLauncher.ts`
- `acpSessionClient.ts`
- `acpSessionManager.ts`
- `acpStreamAdapter.ts`
- `acpPermissionPolicy.ts`

### ACP platform responsibilities

#### Profile registry

Resolve ACP profiles from settings and validate:

- enabled/disabled
- chat availability
- delegate availability
- command/args/env completeness

#### Launcher

Spawn ACP-compatible CLIs with:

- `cwd` bound to the effective thread workspace
- login-shell merged env
- profile env overrides

#### Session client

Wrap the ACP SDK calls used by Yachiyo:

- `initialize`
- `newSession`
- `unstable_resumeSession`
- `prompt`
- `cancel`

#### Stream adapter

Convert ACP streaming updates into Yachiyo-facing events and text chunks.

#### Permission policy

Centralize how ACP permission requests are answered.

For v1, keep the current YOLO direction:

- auto-approve ACP permission requests

This is consistent with the current delegated coding design.

## 2. Two Execution Pathways

### Path A: ACP Chat Runtime

This is the new direct-chat path.

Behavior:

```text
chat.send on ACP thread
-> run.created
-> resolve ACP profile
-> ensure workspace
-> create or resume ACP session
-> send prompt into ACP session
-> stream ACP text into message.delta
-> persist final assistant message
-> run.completed
```

This path should be implemented as a dedicated runtime branch, not inside the current AI SDK runtime.

### Path B: ACP Delegate Runtime

This is the existing `delegateCodingTask` behavior, refactored to use the shared ACP backbone.

Behavior:

```text
normal Yachiyo model thread
-> tool call delegateCodingTask
-> shared ACP backbone runs worker
-> worker summary returned to Yachiyo
-> Yachiyo verifies and replies
```

This keeps delegation as a tool-shaped path while removing duplicated ACP plumbing.

## 3. Backend Branching Rule

The main server run domain should branch early:

- `llm thread` -> existing model execution path
- `acp thread` -> ACP chat execution path

Do not route ACP chat through the current AI SDK model abstraction.

## Thread Model

## 1. Thread backend kind

Each thread needs a backend identity.

Recommended direction:

```ts
type ThreadBackendKind = 'llm' | 'acp'
```

Add a thread-level runtime block, for example:

```ts
interface ThreadRuntimeBinding {
  kind: 'llm' | 'acp'
  profileId?: string
  profileName?: string
  sessionId?: string
  sessionStatus?: 'new' | 'active' | 'expired'
  lastSessionBoundAt?: string
}
```

This should be attached to `ThreadRecord`.

### Why a runtime block is better than more loose top-level fields

- it avoids polluting `ThreadRecord` with many ACP-only fields
- it makes backend mode explicit
- it keeps room for future runtime types

## 2. Thread workspace rule

ACP chat threads must use the thread workspace as their execution root.

That means:

- ACP process `cwd` is the thread workspace
- all ACP coding activity is bound to the thread workspace
- workspace reuse stays consistent with existing Yachiyo agent behavior

## 3. Session persistence rule

For ACP chat threads:

- `sessionId` is stored on the thread
- the session is reused for later turns
- if a session resume fails, Yachiyo must surface that clearly

Do not silently pretend an expired session is the same conversation.

## Settings Model

The current Coding Agents settings are the right source of ACP profiles.

Extend them instead of inventing a second ACP settings surface.

Recommended additions to each profile:

- `showInChatPicker: boolean`
- `allowDelegation: boolean`
- `allowDirectChat: boolean`

This allows:

- some ACP profiles to appear only as workers
- some ACP profiles to appear directly in chat
- some ACP profiles to support both

If a minimal first version is needed, `showInChatPicker` alone is enough, but the longer-lived design should distinguish the two pathways explicitly.

## Chat UX

## 1. Picker shape

The chat picker should present two groups:

- `Models`
- `Agents`

Agents are ACP-backed chat entries.

The user experience should be:

- choosing a model creates or continues a normal LLM thread
- choosing an agent creates or continues an ACP-backed thread

## 2. Thread header

An ACP chat thread should show:

- agent name
- a small “agent-backed” indicator

It should be obvious that:

- this thread is directly connected to an ACP agent
- this is not the same as a delegated background worker

## 3. Composer behavior

The composer should stay normal:

- user types message
- user sends message
- response streams into the timeline
- cancel works

The user should not have to learn a second chat interface for ACP chat threads.

## 4. Timeline behavior

### Direct ACP chat

Should look like normal chat:

- assistant bubble streams
- minimal stage/status messaging
- no “subagent worker” strip

### Delegation

Keeps the existing subagent/delegation feel:

- temporary worker progress
- task-specific summary
- Yachiyo remains the final speaker

## Runtime Behavior

## 1. ACP chat send flow

On `chat.send` for an ACP thread:

1. create run
2. append user message to Yachiyo transcript
3. ensure workspace exists
4. resolve ACP profile
5. if no session id exists, call `newSession`
6. if session id exists, call `unstable_resumeSession`
7. prompt the ACP session with the new user input
8. stream chunks into assistant message updates
9. finalize assistant message
10. persist thread preview and head state
11. complete run

## 2. ACP prompt shape

For direct ACP chat, Yachiyo should not keep replaying full visible history into ACP on every turn.

Instead:

- the ACP session carries ongoing hidden state
- Yachiyo sends the new user turn plus stable per-turn context

Stable per-turn context may include:

- current workspace path
- thread safety constraints
- user document or soul context if still relevant
- channel hint when applicable

This keeps session-backed behavior real instead of pretending ACP is stateless.

## 3. ACP chat message persistence

Yachiyo must still persist:

- user-authored messages
- assistant visible replies
- run records

The Yachiyo transcript remains the UI history.

But for ACP threads, transcript alone is not the full backend state.

That difference must be treated as real.

## 4. Cancellation

Cancellation must:

- cancel the ACP session prompt if possible
- kill the spawned ACP process tree
- finalize the Yachiyo run as cancelled
- leave the thread intact

## 5. Resume failure behavior

If `unstable_resumeSession` fails:

- mark the thread session as expired
- fail the run with a clear message
- offer a product action to start a fresh ACP session in the same thread, or require the next send to do so explicitly

Do not silently replace the old session.

## Protocol Direction

The current event protocol should mostly be reused.

### Direct ACP chat should reuse existing events

- `run.created`
- `message.started`
- `message.delta`
- `message.completed`
- `run.completed`
- `run.failed`
- `run.cancelled`

This keeps the renderer simpler.

### Delegation keeps delegation-specific events

- `subagent.started`
- `subagent.progress`
- `subagent.finished`

This preserves the distinction between “agent is the main speaker” and “agent is a worker”.

### Additional ACP-specific state

Prefer minimal additions.

The thread can be updated when:

- a session id is first bound
- a session becomes expired
- a thread switches backend mode

In many cases, `thread.updated` is enough.

Do not invent a large ACP-only event tree unless a real UI need appears.

## Storage Direction

Storage must be upgraded so ACP-backed threads can survive app restarts.

Required persistence:

- thread backend kind
- ACP profile id/name for ACP threads
- ACP session id
- ACP session status

Recommended approach:

- add a serialized runtime-binding field to thread storage

This is cleaner than scattering ACP-specific columns everywhere unless query requirements later justify normalization.

If the storage layer prefers explicit columns, keep them tightly scoped and avoid mixing them with message/run tables unless necessary.

## Direct ACP Chat Capability Rules

## 1. Supported in v1

- normal send
- follow-up send
- cancel
- session resume
- workspace-bound execution
- clear agent identity in UI

## 2. Limited or disabled in v1

For ACP chat threads, initially disable or clearly degrade:

- retrying older assistant turns
- editing earlier user turns
- replay-based branch creation

Reason:

- ACP session state is opaque and evolves outside Yachiyo’s normal transcript replay system

Do not ship half-correct versions of these features for ACP threads.

## 3. Branching strategy later

If ACP later supports session fork/clone semantics, Yachiyo can add:

- true ACP branch from current session state

Until then, any ACP branch would only be an approximation.

That is a later phase, not v1.

## Delegation Path Requirements

The existing `delegateCodingTask` tool should stay.

Required changes:

- move ACP connection/spawn/session logic into shared ACP modules
- keep `delegateCodingTask` as a thin adapter over the shared ACP backbone
- preserve `session_id` resume behavior
- preserve summary-plus-session-id result format
- preserve Yachiyo-as-reviewer behavior

This ensures:

- direct ACP chat and delegation remain separate product behaviors
- ACP implementation logic is not duplicated

## Safety and Policy

## 1. Permission policy

For v1, keep ACP permission handling auto-approved.

This matches the current direction for delegated coding agents.

If manual approval is later needed, add it as a separate product feature.
Do not block v1 on building a human approval UI that does not exist today.

## 2. Git gate

The existing delegated ACP design requires Git presence for safe YOLO execution.

Recommended v1 rule:

- keep the Git gate for delegation
- for direct ACP chat, require either:
  - a valid Git workspace, or
  - an explicitly chosen thread workspace that the user accepts as YOLO

If product scope must stay tighter, applying the Git gate to both paths is acceptable for v1.

The key point is consistency and clear user expectation.

## 3. Tool boundary

ACP chat threads should not pretend they are using Yachiyo’s native tool loop.

In v1:

- ACP agent uses its own ACP-hosted capabilities
- normal Yachiyo tool toggles do not apply to ACP chat threads

Later bridging can be explored, but not in the first version.

## File and Module Impact

Likely implementation areas:

- `src/shared/yachiyo/protocol.ts`
- `src/main/yachiyo-server/storage/storage.ts`
- `src/main/yachiyo-server/storage/sqlite/schema.ts`
- `src/main/yachiyo-server/storage/sqlite/database.ts`
- `src/main/yachiyo-server/settings/settingsStore.ts`
- `src/main/yachiyo-server/app/domain/runDomain.ts`
- `src/main/yachiyo-server/tools/agentTools/delegateCodingTaskTool.ts`
- `src/renderer/src/features/chat/lib/modelSelectorState.ts`
- `src/renderer/src/features/chat/components/ModelSelectorPopup.tsx`
- `src/renderer/src/features/chat/components/Composer.tsx`
- `src/renderer/src/features/layout/components/AppMainPanelHeader.tsx`
- `src/renderer/settings/panes/CodingAgentsPane.tsx`

Recommended new modules:

- `src/main/yachiyo-server/runtime/acp/acpLauncher.ts`
- `src/main/yachiyo-server/runtime/acp/acpSessionClient.ts`
- `src/main/yachiyo-server/runtime/acp/acpSessionManager.ts`
- `src/main/yachiyo-server/runtime/acp/acpChatRuntime.ts`
- `src/main/yachiyo-server/runtime/acp/acpDelegateRuntime.ts`
- `src/main/yachiyo-server/runtime/acp/acpTypes.ts`

## Testing Requirements

At minimum, add focused tests for:

- ACP profile validation for chat and delegation visibility
- first ACP chat turn creates session and binds it to thread
- later ACP chat turn resumes stored session
- ACP session resume failure marks thread as expired
- ACP cancellation cleans up process and finalizes run correctly
- model/agent picker displays both groups correctly
- ACP chat threads hide unsupported replay-based actions
- delegated ACP path still works after ACP refactor

## Rollout Plan

### Phase 1: Shared ACP foundation

- extract ACP spawn/session logic from the existing delegate tool
- create shared ACP service modules
- keep delegated ACP working through the new shared layer

### Phase 2: Direct ACP chat MVP

- add ACP thread backend metadata
- expose ACP agents in the picker
- implement ACP chat send/run path
- persist and resume ACP sessions
- add clear ACP thread UI state

### Phase 3: Product hardening

- improve expired-session recovery UX
- refine header/picker copy
- add analytics or diagnostics if needed
- tighten unsupported-action handling for ACP threads

### Phase 4: Advanced ACP thread features

Only after the MVP is stable:

- investigate ACP session fork/clone if the protocol grows that capability
- explore cross-path handoff between direct ACP chat and delegation
- explore richer ACP status UI if real usage shows a need

## Acceptance Criteria

This feature should be considered done when:

- Yachiyo can show ACP agents in the chat picker
- selecting an ACP agent creates an ACP-backed chat thread
- subsequent messages in that thread resume the same ACP session
- `delegateCodingTask` still works and uses the same ACP backbone
- both paths share ACP process/session logic instead of duplicating it
- ACP chat threads clearly communicate their mode in the UI
- unsupported replay-heavy actions are intentionally disabled or clearly limited

## Final Position

The correct feature is not “replace delegation with direct ACP chat”.

The correct feature is:

- **one ACP platform**
- **two product pathways**
- **clear separation in UX**
- **shared implementation underneath**

That gives Yachiyo both:

- direct conversation with ACP-backed agents
- delegated ACP work under model control

without forcing one pattern to imitate the other.
