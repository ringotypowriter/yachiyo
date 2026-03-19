# Yachiyo Run-Time Input Modes Brief

## Goal

Define how the composer behaves when a thread already has an active run.

This brief is not about generic concurrent sending.
It is about giving Yachiyo a clean, explicit model for two different kinds of input during an active run:

- `steer`: input that influences the current in-flight run
- `follow-up`: input that becomes the next formal request after the current run settles

The design must make these two behaviors feel intentional, lightweight, and understandable.
It must also allow the keyboard behavior to be configurable in Settings.

## Product Direction

Yachiyo should not treat `active run` as a simple global send lock.
That model is too blunt.

When a run is active, the composer should still accept input, but the send gesture must be interpreted according to a run-time input mode policy.

The product should preserve three different user intents:

- send a normal message when idle
- steer the current answer while it is still being generated
- queue the next message without interrupting the current answer

These intents are different and should not be collapsed into a single overloaded send action.

## Core Concepts

### 1. `steer`

`steer` is a normal user message submitted while a thread already has an active run.
Its job is to influence how the current response continues.

Examples:

- "Focus on the error path first."
- "Use the existing auth helper instead of rewriting it."
- "Keep the answer short."

Product meaning:

- it is still a normal thread message
- it is immediately appended to the thread timeline
- when sent during an active run, it is consumed by the current run rather than opening a separate new run
- it should feel immediate

### 2. `follow-up`

`follow-up` is also a normal user message.
If a run is active, it is queued and executed after the current run finishes.

Examples:

- "After this, compare it with the old implementation."
- "Then generate a migration checklist."
- "Next, explain the trade-offs in Chinese."

Product meaning:

- it is a normal thread message
- it is intended for the next run, not the current one
- it becomes the next formal request after the current run settles
- it should feel deliberate, not accidental

## Message Semantics

Both `steer` and `follow-up` are ordinary user messages.
The important difference is not whether they count as messages.
The important difference is which run consumes them.

- idle send: a normal user message opens a new run
- active-run `steer`: a normal user message is immediately appended to the thread and consumed by the current run
- active-run `follow-up`: a normal user message is appended as queued intent for the next run and is consumed only after the current run settles

This model keeps the timeline intuitive for users.
They are always sending messages.
What changes is how the system schedules those messages.

## Keyboard Model

The keyboard behavior during an active run must be configurable in Settings.

Recommended default:

- idle thread:
  - `Enter` sends a normal message
  - `Shift+Enter` inserts newline
- active run:
  - `Enter` sends `steer`
  - `Alt+Enter` / `Option+Enter` sends `follow-up`
  - `Shift+Enter` inserts newline

Why this default:

- `Enter` keeps `steer` on the fastest path
- `Alt+Enter` keeps `follow-up` available without stealing the standard newline gesture
- `Shift+Enter` remains stable across idle and active states

## Settings Requirement

This behavior must not be hardcoded.
It needs a user-facing setting.

At minimum, Chat Settings should expose a run-time input preference that decides which shortcut is used for `steer` and which is used for `follow-up` while a run is active.

Recommended MVP setting shape:

- setting group: `Chat`
- setting label: `When a reply is still running`
- options:
  - `Enter steers, Alt+Enter queues follow-up` (recommended default)
  - `Alt+Enter steers, Enter queues follow-up`

Hard rule:

- `Shift+Enter` should remain newline in both modes

Why this should be configurable:

- some users want the fastest possible steer path
- some users will prefer to protect plain `Enter` from accidental steering during long runs
- this preference is ergonomic and personal, not thread-specific

Scope rule:

- this is an app-level preference
- it is not thread-level
- switching threads must not change it

## Composer Behavior While Running

When a thread has an active run, the composer should remain usable.
Do not turn it into a dead input box.

Desired behavior:

- the textarea remains editable
- image previews may still remain visible if draft state supports them
- the composer shows a small local hint about the active keyboard behavior
- the main send affordance remains calm and compact

Recommended hint examples:

- `Enter to steer, Option+Enter to queue follow-up`
- `Option+Enter to steer, Enter to queue follow-up`

The hint should reflect the user setting.

## Send-State Rules

### Idle thread

When there is no active run:

- send works like a normal chat composer
- `Enter` sends the message
- images behave as standard outgoing message content

### Active run

When a run is active:

- the composer does not become globally blocked just because the run exists
- send behavior depends on the configured keyboard mapping
- the resulting action is either `steer` or `follow-up`

### Still-blocked cases

Even during an active run, the composer should only block for real reasons such as:

- nothing to send
- image still loading
- image preparation failed
- provider/model unavailable
- local server disconnected
- payload type unsupported for the chosen action

## Payload Rules

Recommended MVP boundary:

- `steer` should support the same message payload types already supported by the normal send path, including images if the current composer/message pipeline already supports them
- `follow-up` should also support the same payload types as the normal send path

Why:

- if `steer` is a normal user message, it should not lose capabilities that ordinary messages already have without a strong product reason
- reusing the ordinary message path keeps multimodal behavior simpler and more predictable
- the product distinction between `steer` and `follow-up` should come from scheduling semantics, not from arbitrary payload restrictions

If there is a runtime limitation for a specific payload in active-run `steer`, surface that as an implementation constraint rather than redefining `steer` as a special non-message type.

## Persistence and Timeline Semantics

### `steer`

`steer` should be persisted as an ordinary user message in the thread timeline.
The key semantic difference is not message shape but execution routing.

Recommended direction:

- append the `steer` message to the normal thread timeline immediately
- preserve ordinary message rendering behavior, including any supported image display
- when sent during an active run, route that message into the current run instead of opening a separate parallel run
- make the resulting UI feel like the user sent another message into the same live conversation

### `follow-up`

`follow-up` should also be treated as an ordinary user message, but with queued execution semantics while the current run is still active.
After the current run settles, it should become the next real request and start the next run.

Recommended direction:

- represent it as a normal user message with queued-for-next-run semantics
- keep it visible in the thread timeline so the user can see what they already sent
- once the active run settles, consume that queued message through the next-run path
- preserve the user's message content if execution fails before the queued follow-up is formally accepted

## Queue Policy

Recommended MVP:

- allow one active run per thread
- allow one queued follow-up per thread
- if the user tries to queue another follow-up while one is already pending, the product should choose one clear policy and stick to it

Recommended default policy:

- replace the existing queued follow-up with the newly submitted one
- surface a tiny confirmation hint such as `Queued follow-up updated`

This is cleaner than building a multi-item queue in the composer too early.

Implementation note:

- if `follow-up` is already visible as a normal user message in the thread timeline, replacement semantics should update or supersede that queued message in a way that remains understandable in UI and storage

## Settings and Data Model Impact

This feature likely requires extending app config beyond `enabledTools`.
The current `SettingsConfig` is too narrow for this behavior.

The implementation should add a chat-level preference for run-time input behavior.
A reasonable direction would be a field conceptually similar to:

- `chat.runInputBehavior`
- or `chat.activeRunEnterBehavior`

The exact field name is up to implementation, but the semantics must support:

- app-level persistence
- bootstrap hydration
- settings update events
- renderer access without thread coupling

## UX Principles

### Preserve normal typing habits where possible

Do not destroy multiline writing ergonomics just to add active-run controls.
Keeping `Shift+Enter` as newline is the cleanest baseline.

### Make run-time behavior discoverable, not noisy

The user should not need a modal or a floating command palette just to understand what Enter does during a run.
A small local hint is enough.

### Keep `steer` fast

If `steer` exists, it should feel immediate.
If it requires too much ceremony, users will stop using it.

### Keep `follow-up` deliberate

`follow-up` should feel intentional because it changes what happens after the current run.
A modified shortcut is appropriate.

## Suggested Delivery Order

1. Add settings support for active-run input behavior
2. Update composer keyboard handling to respect the setting
3. Update send-state logic so active run is no longer treated as a blanket send block
4. Add `steer` and `follow-up` submission paths in store / IPC / server layers
5. Add persistence and rendering for ordinary `steer` messages during active runs and queued `follow-up` messages
6. Add tests for keyboard behavior, blocked states, and queue replacement semantics

## What Implementation Must Decide

Codex should inspect the current renderer, preload, main process, and server runtime, then choose the most suitable implementation details for:

- where the new chat preference lives inside settings/config
- how settings UI exposes the two active-run keyboard modes
- how ordinary user messages are marked or routed differently when used as `steer` versus `follow-up`
- how queued `follow-up` messages are represented before and while they are waiting to be consumed by the next run
- when the queued follow-up is materialized after run completion
- how run-time input hints are shown in the composer without adding clutter

## Deliverable Expectation

When this round is done, a user should be able to:

- keep typing while a run is active
- understand what pressing `Enter` will do right now
- steer the current run intentionally
- queue the next request intentionally
- keep normal multiline input behavior
- customize the active-run shortcut behavior in Settings

The result should feel like a real interactive chat system, not like a disabled input box with a stop button.
