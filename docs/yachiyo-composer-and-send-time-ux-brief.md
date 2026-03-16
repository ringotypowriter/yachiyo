# Yachiyo Composer and Send-Time UX Brief

## Goal

Implement the next stage of Yachiyo chat UX around the time before sending and during sending.

This round should focus on making the composer feel like a real chat product, while also introducing image input as a first-class input type.

The emphasis is not on adding every possible input mode at once.
The emphasis is on building a clean, coherent input experience that matches the current architecture and product direction.

## Product Direction

Yachiyo is no longer just a linear message demo.
It already has thread branching, in-thread retry branches, delete-from-here semantics, and message-level actions.

The next input-focused stage should therefore optimize for:

- clear send intent
- reliable draft behavior
- smooth pre-send experience
- understandable in-progress behavior
- room for image input without turning the composer into a noisy attachment panel

This stage should not overreach into large multi-file upload systems, generic attachments, or resume-style runtime control if the current runtime does not support those semantics cleanly.

## Priority Decision

Image support needs to be considered now and should be treated as a priority input type.

However, image support should be introduced in a way that feels native to the composer, not like a bolted-on enterprise upload workflow.

So the focus for this round is:

- composer and draft UX
- image input support
- send-time behavior and feedback

Not the focus for this round:

- broad arbitrary file attachments as a generic system
- pause / resume generation controls unless the runtime semantics are explicitly defined
- overcomplicated attachment management UI

## Scope

### 1. Thread-aware draft behavior

The composer should stop behaving like a single global input box.

Desired behavior:

- each thread has its own draft state
- switching threads restores that thread's draft
- creating a new thread starts with an empty draft by default
- successful send clears the current thread draft
- failed send preserves the draft
- branch creation should have a clearly defined draft outcome for the destination thread

Recommended default:

- branching into a new thread opens with an empty draft unless there is a strong product reason to carry text over

Why this matters:

- thread-aware drafting makes the app feel like a serious chat tool
- it avoids accidental loss of user intent while switching context

### 2. Image input as a first-class composer action

Images should be supported now.
But they should be treated as a deliberate first-class input mode, not as one small case inside a generic future attachment bucket.

Desired behavior for MVP:

- users can add an image before sending
- image selection should feel lightweight and local to the composer
- selected images should be visible in the composer before send
- users should be able to remove an image before send
- sending should make it obvious whether the outgoing message contains text, image, or both

Recommended acquisition methods for MVP:

- click to pick image from disk
- paste image from clipboard if practical within the current Electron/renderer architecture
- drag-and-drop is optional if it falls out naturally from the same implementation path

Recommended product boundary:

- prioritize image types only
- do not try to support arbitrary files in the same first pass unless the model/runtime path is already designed for them

Why this boundary matters:

- images are a strong product need
- generic file upload will drag the UX and protocol into a much larger design space
- treating image as the first supported rich input type keeps the product focused

### 3. Pre-send composer clarity

The composer should make it clear what will happen when the user sends.

Desired behavior:

- the user can tell whether they are sending text only, image only, or text plus image
- blocked send states should be understandable
- the composer should not silently fail when sending is unavailable

Examples of useful blocked-state clarity:

- no provider configured
- current run still active
- nothing to send
- image is still processing or not ready

This does not require giant banners.
Small, calm, local feedback is preferred.

### 4. Send-time behavior

Once a message starts sending, the composer should behave predictably.

Questions the implementation must answer well:

- can the user keep typing the next draft while the current run is active, or is the composer intentionally locked?
- if locked, is the reason visually obvious?
- if images are present, when are they committed and cleared?
- what happens if the send fails after image selection?

Recommended default for MVP:

- keep send semantics conservative and reliable
- if the current product model assumes one active run per thread, do not fake concurrent send behavior
- preserve unsent input when failure happens

### 5. Input-state polish

This round should also tighten the small behaviors that make a composer feel good.

Examples:

- `Enter` sends, `Shift+Enter` inserts newline
- auto-resize remains stable
- focus behavior feels intentional after send / stop / retry / branch navigation
- image preview chips or thumbnails feel quiet and readable
- model selector and input affordances do not fight each other visually

## Image UX Principles

### Treat image as message content, not luggage

The product should present images as part of what the user is saying, not like a hidden binary payload attached off to the side.

### Keep image preview close to the input

If the user has selected images, they should be visible near the composer so the outgoing message is obvious before send.

### Prefer one clean image flow over five partial ones

It is better to support one or two image acquisition paths really well than to add many shallow entry points with inconsistent behavior.

### Do not overbuild attachment management

Avoid turning the bottom bar into a file manager.
This stage is about chat input, not document workflow.

## Product Boundaries and Feasibility

These are strong candidates for this round:

- per-thread drafts
- failure-safe draft retention
- clear blocked send states
- image picking from disk
- image preview before send
- remove-image-before-send
- calm send-time feedback

These may be included only if they fall out naturally from the same implementation path:

- paste image from clipboard
- drag-and-drop image into composer

These should not define the round unless architecture is already ready for them:

- arbitrary file attachments
- resume generation
- pause generation
- complex multi-asset queue management
- broad multimodal upload matrix beyond images

## Interaction Principles

### Keep the composer small, but not empty

The composer should remain calm and minimal, but it should still communicate enough state to feel trustworthy.

### Make rich input visible before send

If the outgoing message contains an image, users should not have to guess that.

### Preserve intent

The system should work hard not to destroy user input accidentally.
Draft loss is one of the fastest ways to make chat UX feel cheap.

### Avoid fake capability

Do not add polished controls for behaviors that are not yet backed by stable runtime semantics.

## Suggested Delivery Order

1. Per-thread draft model
2. Send-state and blocked-state clarity
3. Image picking and preview
4. Image send semantics and failure behavior
5. Clipboard image support if practical
6. Drag-and-drop image support if it comes naturally

## What Codex Should Decide

Codex should inspect the current renderer, preload, main process, and runtime path, then choose the most suitable implementation details for:

- where thread-specific drafts live
- how image input is represented before send
- how image payloads move through renderer to main/runtime
- whether image support lands as one image or a small bounded list in MVP
- how blocked-state feedback appears without cluttering the composer
- how send failure preserves text and image intent

The implementation should follow the product semantics in this brief, rather than inventing a generic attachment framework prematurely.

## Deliverable Expectation

When this round is done, Yachiyo should feel noticeably better in the moments before sending and during sending.

A user should be able to:

- type in one thread without losing drafts in another
- understand why send is or is not available
- add an image intentionally
- see that image before sending
- send text, image, or both with confidence
- recover gracefully if a send fails

The result should feel like a chat product growing richer, not like a settings panel leaking into the composer.
