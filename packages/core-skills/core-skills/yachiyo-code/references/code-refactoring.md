# Code Refactoring

Changing the shape of code without changing what it does. The hardest discipline: shipping nothing visible while making everything better.

## The Refactoring Contract

A refactor is **behavior-preserving**. By definition:

- No bug fixes inside a refactor.
- No new features inside a refactor.
- No API changes that callers can observe (unless the refactor is explicitly an API change).
- Tests that passed before should pass after, unmodified — that's how you prove behavior is preserved.

If you change behavior during a "refactor," it's not a refactor. It's a feature, a fix, or a stealth change. Split them.

## When to Refactor

Refactor when:

- The next feature is hard to add because the current shape fights you.
- The same logic has been copy-pasted 3+ times and the pattern is now clear.
- A reader (you or someone else) consistently struggles to understand a section.
- A bug class keeps recurring because the structure invites it.
- You're about to touch the area anyway, and a small reshape will make the change cleaner.

Don't refactor when:

- The code is ugly but working and you have no upcoming reason to touch it.
- You don't understand the code yet — you'll erase intent without knowing it.
- You don't have tests covering the behavior you're about to reshape.
- It's Friday afternoon.

## Pre-Refactor Checklist

Before changing one line:

1. **Tests cover the behavior.** If they don't, write characterization tests first — capture what the code currently does, even if it's weird. Then refactor with the safety net.
2. **You can describe what the code does in one sentence.** If you can't, you don't understand it well enough to reshape it.
3. **You have a target shape in mind.** "Make it cleaner" is not a plan. "Extract the validation into a pure function so we can test it independently" is.
4. **The refactor is in scope of what was asked.** Stealth refactors during feature work are scope creep.

## Small Steps, Always

The single biggest predictor of refactoring success: step size.

- One named transformation per commit (extract function, rename, inline, move).
- Tests pass after each step.
- If you make 5 changes and tests fail, you don't know which change broke what.

Common safe transformations:

- **Extract function/method** — pull a block into a named function with the same behavior.
- **Inline** — the inverse, when an indirection isn't earning its keep.
- **Rename** — better name, same thing.
- **Move** — relocate a function/class to a more sensible module.
- **Introduce parameter object** — bundle related arguments.
- **Replace conditional with polymorphism** — when the same `if/switch` shape appears in many places.
- **Replace inheritance with composition** — when the inheritance is structural rather than semantic.

Each of these has a clear definition. "Make it cleaner" doesn't.

## Use the Tools

Modern editors have rename, extract, move refactorings built in. They're more reliable than hand-editing because they update all references atomically. Use them when available.

## Behavior-Preserving vs Behavior-Changing

When you discover a bug during a refactor:

1. Stop the refactor.
2. Decide: fix the bug now, or after?
3. Either way, the bug fix is a separate commit with its own test.
4. Resume the refactor (now behavior-preserving relative to the fixed behavior).

Bundling a bug fix into a refactor commit destroys reviewability.

## Refactoring Old Code Without Tests

Common situation. You can't safely refactor untested code. Two options:

1. **Add characterization tests first.** Write tests that pin down current behavior — even bugs become tested. Then refactor with the net.
2. **Refactor by parallel implementation.** Build the new shape alongside the old, route a small percentage of traffic, verify, then swap. Slower but safer for high-stakes systems.

What you don't do: refactor untested code by eyeball and hope. That's how regressions ship.

## Knowing When to Stop

A refactor done right opens the door to the feature; it doesn't try to fix every problem in the codebase. Set a boundary up front: "I'm reshaping these 3 modules so the new feature has a place to live." Stop at the boundary even if neighboring code is calling out for love.

Endless refactor loops are how weeks disappear.

## Anti-Patterns

- **The Big Rewrite.** Replacing a working system with a "cleaner" version that doesn't do everything the old one did. Never works on the first try, often never works.
- **Refactor + behavior change in one commit.** Reviewer can't tell what changed semantically.
- **Refactor without tests.** You're not refactoring, you're rewriting from memory.
- **Refactoring to a pattern.** "I'll make this match the Strategy pattern" — only valuable if the pattern actually fits the problem, not for its own sake.
- **Premature abstraction.** Two similar things ≠ a pattern. Three is the minimum, four is more honest.
- **Renaming without grep.** Symbol renames must update every caller, including strings, comments, docs, and dynamic references.

## Commit Messages

Refactor commits should say what shape changed and why:

```
refactor(parser): extract token classifier into pure function

Pulls the 80-line classify() switch out of the main parse loop into
its own function. No behavior change. Sets up the upcoming template
literal support (#412), which needs to call the classifier independently.
```

The "no behavior change" line is load-bearing — it tells reviewers what to look for (and what _not_ to look for).
