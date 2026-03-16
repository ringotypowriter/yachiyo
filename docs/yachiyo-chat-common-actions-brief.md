# Yachiyo Chat Common Actions Brief

## Goal

Implement the next batch of high-frequency chat interactions for Yachiyo.

This round should focus on four common actions:

- Copy message
- Retry
- Create branch
- Delete message

The goal is not to add flashy features.
The goal is to make chat feel like a real product with clean, reliable everyday interactions.

## Product Direction

Yachiyo is `chat-first, agent-ready`.

That means these actions should feel like natural parts of the conversation UI, not like developer tools bolted onto a message list.

The implementation should optimize for:

- low friction
- clear semantics
- predictable outcomes
- good defaults
- room for future run-aware / branch-aware evolution

Do not over-engineer the first pass, but do not implement these in a way that will obviously block future thread/run/message modeling.

## Scope

Implement the UX and supporting behavior for these four actions:

### 1. Copy message

Users should be able to copy any user or assistant message quickly.

Desired behavior:

- show a lightweight message action area on hover or focus
- provide a `Copy` action for both user and assistant messages
- copy the message content as plain text
- show a short-lived success feedback such as `Copied`

Notes:

- keep this simple; do not start with multi-format clipboard support
- do not confuse full-message copy with future code-block-only copy
- action styling should be quiet and consistent with the current chat UI

### 2. Retry

Retry should be treated as re-running a previous user request, not as a magical mutation of an assistant bubble.

Recommended semantics:

- the user triggers retry from the assistant result area for a previous exchange
- retry uses the corresponding historical user message as input
- retry does not create a new thread
- retry creates a new run for the same request anchor inside the current thread
- the result should be added as a parallel assistant response branch for that same request
- do not replace or overwrite the previous assistant response

Desired UX:

- action label can be `Retry`
- keep the previous answer visible
- make it clear that the new result is another response to the same earlier request, not a continuation after the old answer
- after retry starts, the standard preparing / streaming UX should appear

Notes:

- this should preserve conversation history
- users should be able to compare sibling answers for the same request
- avoid ambiguous behavior like silently editing old messages in place
- do not model retry as a new thread; that is the role of branch

### 3. Create branch

Create branch should mean: start a new thread from a historical point in the conversation.

Recommended semantics:

- user can trigger `Create branch` from a message in an existing thread
- the new thread inherits conversation context up to that message
- the new thread becomes an alternate continuation from that point
- later messages after the branch point in the original thread are not copied into the new branch

Desired UX:

- the action should feel like `continue from here in a new thread`
- after branch creation, switch the UI into the new thread, or otherwise make the transition extremely clear
- naming can be lightweight for MVP, for example reusing the default thread title or a derived title

Notes:

- this is primarily a thread-level operation, even if it is triggered from a message action menu
- keep the branching rule simple and deterministic

### 4. Delete message

Delete is the most sensitive action in this batch.
It must have clear semantics.

Recommended semantics for MVP:

- deleting a user request or assistant response removes that node and everything that depends on it inside the current thread structure
- in practice, delete should behave like truncating the relevant path from that point onward
- when retry creates parallel assistant response branches for the same request, deleting one response branch should not automatically delete its sibling responses
- deleting the user request anchor should remove all response branches attached to that request

Why:

- deleting only one middle node while preserving dependent descendants will make the thread history incoherent
- truncation keeps context history self-consistent
- this aligns with retry as an in-thread response branch and branch as a new-thread operation

Desired UX:

- label can be `Delete from here`
- require a confirmation step
- confirmation copy should make it obvious what will be removed

Notes:

- do not implement this as a cosmetic hide-only action
- treat this as a real history edit operation

## Interaction Principles

### Keep actions lightweight

Do not turn each message into a noisy toolbar.
Actions should appear only when useful, likely on hover/focus, and should stay visually secondary to message content.

### Respect message roles but keep affordances consistent

User and assistant messages may not expose the exact same actions, but the overall interaction language should feel unified.

Example:

- both can support copy
- assistant messages can expose retry
- both may become valid branch points depending on how the timeline model works
- delete semantics should stay consistent with timeline truncation

### Prefer clarity over cleverness

If a behavior could be interpreted in two ways, choose the one that is easier for users to predict.

### Avoid implementation leakage

Do not expose raw runtime terms or backend event jargon in the UI for these actions.
The UI should speak in chat/product language.

## Suggested Modeling Direction

Use these as product-level anchors while choosing implementation details:

- `Copy` is primarily a message-level display action
- `Retry` is primarily an in-thread response-branch action, creating a sibling assistant response for the same historical request
- `Create branch` is primarily a thread-level action from a historical cutoff point
- `Delete from here` is primarily a thread-history edit action

Do not feel forced to encode this exactly in one specific store shape yet, but do keep these boundaries in mind.

## Suggested Delivery Order

Implement in this order unless the codebase strongly suggests a better internal sequence:

1. Copy
2. Retry
3. Delete from here
4. Create branch

Reasoning:

- Copy is low-risk and establishes the message action affordance
- Retry completes a core chat loop
- Delete requires explicit timeline semantics
- Create branch is easiest to do cleanly once historical cutoff behavior is already well understood

## UX Quality Bar

The result should feel:

- calm
- obvious
- fast
- not over-decorated
- consistent with the current Yachiyo interface

Avoid:

- giant action bars
- heavy dropdowns for trivial actions
- destructive actions without explicit confirmation
- replacing message history in place when appending is clearer

## What Codex Should Decide

Codex should inspect the current renderer/store/server structure and choose the most suitable implementation details, including:

- where message actions are rendered
- whether actions appear inline or in a compact hover menu
- how retry maps back to the corresponding historical user message and creates a sibling response branch inside the same thread
- how branch creation copies or reconstructs context history
- how delete-from-here is persisted

The implementation does not need to match a pre-written code contract.
It should match the product semantics in this brief.

## Deliverable Expectation

Implement the feature set end-to-end where practical.
If some actions need backend support, add the minimal protocol/storage/server changes required.

When done, the result should let a user naturally:

- copy a message
- retry an earlier answer
- branch from a previous point
- delete a conversation from a chosen point onward

without the chat UI feeling like a debug console.
