# Handoff — Yachiyo (Time-Sliced)

## Purpose

This handoff is organized by time, not by subsystem.
It captures how the understanding evolved in this thread, what was corrected, and what the next thread must not get wrong.

## T0 — Starting Point / Old Handoff Assumption

We started from the older handoff:

- `.alma/handoff-mmq7th3vyqhjicupdc.md`

That older handoff was useful for the historical arc, but some of its conclusions were now stale relative to the repo.
In particular, it still described Yachiyo as if the pi-style tool-contract work was mostly ahead of us.

At that point, the working assumption was:

- next step was still to keep pushing the `read/write/edit/bash` contract toward pi-mono
- the main unfinished area was `agentTools.ts` / protocol semantics

This assumption turned out to be incomplete / partially outdated after code inspection.

## T1 — Reality Check Against Current Repo

I inspected the current repo state and found that the pi-style tool-contract line is already much further along than the old handoff suggested.

Important files inspected:

- `src/main/yachiyo-server/tools/agentTools.ts`
- `src/shared/yachiyo/protocol.ts`
- `src/main/yachiyo-server/app/YachiyoServer.ts`
- `src/main/yachiyo-server/runtime/modelRuntime.ts`
- `src/main/yachiyo-server/tools/agentTools.test.ts`
- `src/renderer/src/features/chat/components/ToolCallRow.tsx`

What was already true in repo:

- `read` already used `path + offset + limit`
- `write` already returned structured details
- `edit` already used `path + oldText + newText`
- `bash` already had streaming-capable behavior, truncation metadata, and output spill path support
- tool records in protocol/storage already supported richer `details`
- server runtime already emitted `tool.updated` start / update / finish lifecycle events

So one major correction from this thread is:

- the next step is no longer "keep redoing the base tool contract from scratch"
- that line is mostly landed already

## T2 — Renderer Follow-Through Was The More Immediate Gap

After that repo inspection, the strongest next-step candidate shifted to renderer consumption of the richer tool data.

Observed issue:

- `src/renderer/src/features/chat/components/ToolCallRow.tsx` was initially only showing summary-level info
- the backend had richer `details`, but the renderer was not really using them yet

The proposed direction at that stage was:

- keep tool rows compact by default
- add lightweight expandable details
- do not overbuild a big inspector panel

This was the correct direction at that time.

## T3 — Tool Row Expansion Was Landed

Later in this thread, I re-checked the renderer and confirmed that this had already been implemented.

Observed current state:

- `src/renderer/src/features/chat/components/ToolCallRow.tsx` now has expand / collapse behavior
- detail presentation is delegated via:
  - `src/renderer/src/features/chat/lib/toolCallPresentation.ts`
- tests also exist for the presentation layer

Meaning:

- "renderer should consume richer tool details" is no longer the next task either
- that work is now effectively landed

## T4 — Composer `Tools` Button Became The New Focus

After tool row expansion was found to be done, the next obvious unfinished area became the composer `Tools` button.

Relevant file:

- `src/renderer/src/features/chat/components/Composer.tsx`

What stood out:

- the button existed visually
- it showed a wrench icon and a badge
- but there was no real interaction wired behind it in the checked code path

At first, I incorrectly treated it like a possible fake / placeholder affordance.
That interpretation was later corrected by Ringo.

## T5 — Critical Product Clarification: `Tools` Is Real

Ringo explicitly corrected the intended product meaning:

- the composer `Tools` button is not decorative
- it is meant to control whether tools are enabled

That means the correct product direction is:

- `Tools` should open a real lightweight control surface
- it should govern enable / disable state for the core agent tools
- it should not be removed as a fake affordance

This is a hard product correction from this thread.

## T6 — Second Critical Correction: Tool Preference Is NOT Thread-Level

A second major correction came immediately after that:

- tool preference is **not** thread-level

This matters a lot because the tempting implementation path was to piggyback on thread-aware composer draft state.
That would be wrong.

Hard constraint established in this thread:

- do **not** store tool enable / disable state as thread-scoped draft state
- do **not** switch tool preference when switching threads
- do **not** treat tool preference as part of branch / thread history

Correct scope is instead:

- shared composer / app-level send-time preference
- future sends use current shared preference
- active runs should not be retroactively affected by toggle changes

Memory note:

- this decision was stored and then updated in memory during the thread
- final constraint is: `Tools` controls tool enable state, but that preference is not thread-level

## T7 — Deep Correction About pi-mono `edit`

This is the most important technical correction from the later part of the thread.

Ringo explicitly pointed out that I had still been missing the real center of gravity of pi-mono's `edit` tool.
The key correction is:

- pi-mono `edit` is **not** just "search/replace"

I then inspected the real local pi-mono sources:

- `/tmp/pi-mono/packages/coding-agent/src/core/tools/edit.ts`
- `/tmp/pi-mono/packages/coding-agent/src/core/tools/edit-diff.ts`
- `/tmp/pi-mono/packages/coding-agent/src/modes/interactive/components/tool-execution.ts`

What pi-mono `edit` actually is:

- it takes `path + oldText + newText`, yes
- but its true semantics are a **surgical anchored edit**, not a generic replace operation

Important properties of pi-mono `edit`:

- exact match is tried first
- fuzzy matching is used as fallback
- fuzzy normalization handles:
  - trailing whitespace normalization
  - smart quote normalization
  - Unicode dash / hyphen normalization
  - special-space normalization
  - Unicode compatibility normalization
- the target text must be unique
- ambiguous multi-match is treated as an error
- zero-match is treated as an error
- no-op replacement is treated as an error
- the tool is diff-centric:
  - it generates diff details
  - it returns `firstChangedLine`
  - the TUI can preview edit diffs before execution

So the right mental model is:

- pi-mono `edit` is a unique-anchor, surgical, diff-oriented edit primitive
- it is not ordinary search/replace
- it is not replace-all
- it is not "replace first occurrence and move on"

This point must be treated as a major correction for any future Yachiyo implementation review.

## Current State Summary

As of the end of this thread, the best current understanding is:

- the core pi-style tool-contract line in Yachiyo is already largely landed
- renderer consumption of richer tool details is also largely landed
- the composer `Tools` button remains the most obvious unfinished product surface
- `Tools` must control real tool enable / disable state
- tool preference is not thread-level
- any review of Yachiyo's `edit` semantics must stop treating pi-mono `edit` as mere search/replace

## What The Next Thread Should Do

The next thread should focus on the composer `Tools` path, with these hard constraints:

- implement `Tools` as a real lightweight control surface for tool enable / disable state
- keep the preference non-thread-scoped
- make future runs honor the selected enabled-tool set
- active runs should not be affected retroactively
- do not model this as thread draft state

And if that work touches Yachiyo's internal understanding of tools, keep this technical guardrail in mind:

- when aligning `edit` semantics with pi-mono, do not stop at `oldText/newText`
- the important part is surgical anchored edit behavior with uniqueness, fuzzy matching, and diff semantics

## Files Worth Rechecking First In The Next Thread

- `src/renderer/src/features/chat/components/Composer.tsx`
- `src/renderer/src/app/store/useAppStore.ts`
- `src/main/yachiyo-server/tools/agentTools.ts`
- `src/main/yachiyo-server/app/YachiyoServer.ts`
- `src/main/yachiyo-server/runtime/modelRuntime.ts`
- `src/shared/yachiyo/protocol.ts`
- `/tmp/pi-mono/packages/coding-agent/src/core/tools/edit.ts`
- `/tmp/pi-mono/packages/coding-agent/src/core/tools/edit-diff.ts`

## Do Not Lose These Corrections

If a future thread starts from old assumptions, correct them immediately:

- do not assume the next task is still base tool-contract refactoring
- do not assume renderer still lacks expandable tool detail UI
- do not treat the composer `Tools` button as decorative
- do not make tool preference thread-level
- do not reduce pi-mono `edit` to naive search/replace
