# Bug Fixing

A bug fix has one job: make the wrong thing right. Nothing else.

## Sequence

1. **Reproduce first.** A bug you can't reproduce is a bug you can't fix. If repro is hard, write down the exact steps before touching code.
2. **Find the root cause, not the symptom.** Ask "why does this happen?" until you reach something that isn't another symptom. The fix should attach to the root.
3. **Write a failing test that captures the bug.** Then fix. The test guards against regression; without it, the same bug returns in six months.
4. **Smallest diff that fixes it.** Resist refactoring touched files. Resist renaming. Resist style cleanup. Open a separate PR for that.
5. **Verify the fix doesn't break adjacent behavior.** Run tests in the same module, exercise neighboring features.

## Reproduction Discipline

Before fixing, you should be able to answer:

- What inputs trigger the bug?
- What's the expected output?
- What's the actual output?
- Is it deterministic, or does it require a specific state / timing / environment?

If you can't answer all four, you're guessing. Bug fixes built on guesses tend to either miss the bug or introduce a new one.

## Root-Cause Discipline

When you find _a_ cause, ask once more: "is this the deepest cause, or is something upstream producing this state?" Fixes at the symptom layer often paper over a deeper bug that resurfaces elsewhere.

Common symptom-layer fixes that hide bugs:

- Adding a null check when you should ask why it's null.
- Catching an exception when you should fix what's throwing it.
- Adding a retry loop when you should fix the flaky dependency.
- Adding a sleep / timeout when you have a race condition.
- Special-casing one input when the parser is wrong.

## Bisecting When You're Stuck

If you can't pinpoint when the bug appeared:

1. `git bisect` between a known-good and known-bad commit.
2. Or comment out half the suspicious code, see if the bug remains, repeat.
3. Or add logging at the boundary between two suspects.

Don't keep staring at the same 20 lines hoping for inspiration.

## Commit / PR Description

Write **why** the bug happened, not just what you changed. Future-you debugging a similar issue will read this and save an hour.

Good template:

```
Fix: <one-line summary of the user-visible problem>

Root cause: <what was actually wrong>
Fix: <what you changed and why it addresses the root cause>
```

Example:

```
Fix: stale data shown after concurrent edit

Root cause: cache invalidation ran before the write transaction committed,
so the second reader observed the pre-write state and re-cached it.
Fix: move invalidation to the after-commit hook so it observes the new state.
```

## Anti-Patterns

- **Fix + refactor in one commit.** Reviewers can't tell what fixed the bug.
- **Bug fix without a test.** Same bug, six months later.
- **"Defensive" wrapping** — wrap everything in try/except, null-check everything. You're hiding bugs, not fixing them.
- **Silent fallback.** Catching an error and returning a default turns a loud bug into a quiet one.
- **Reverting to make it green.** If a test started failing, understand why before reverting the code that made it fail.
- **Fixing the test instead of the code.** Sometimes the test was right and the code regressed.

## When the Bug Is Actually a Feature Request

If the "bug" is "the system doesn't do what I want," that's a feature, not a bug. Stop, surface the ambiguity, get alignment on what the correct behavior is, then proceed. Don't quietly redefine behavior under the label of a bug fix.
