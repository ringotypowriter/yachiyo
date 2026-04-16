---
name: yachiyo-code
description: Coding discipline reference for software engineering tasks. Read when starting any nontrivial code work — greenfield projects, bug fixing, writing tests, refactoring, iterating on existing codebases, writing docs, or explaining a codebase. Hub skill that points to task-specific reference files; load the reference that matches the task before editing.
---

# Yachiyo Code

A reference, not a checklist. Read the core principles below, then load the reference file that matches the task type. Multiple may apply (e.g. bug-fixing + test-development) — load both.

## When to load which reference

| If the task is…                                   | Load                                                    |
| ------------------------------------------------- | ------------------------------------------------------- |
| Starting a new project / scaffolding from zero    | [greenfield.md](references/greenfield.md)               |
| Fixing a bug, regression, or unexpected behavior  | [bug-fixing.md](references/bug-fixing.md)               |
| Writing or modifying tests                        | [test-development.md](references/test-development.md)   |
| Reshaping code without changing behavior          | [code-refactoring.md](references/code-refactoring.md)   |
| Adding features or extending an existing codebase | [project-iteration.md](references/project-iteration.md) |
| Writing READMEs, API docs, guides, code comments  | [doc-writing.md](references/doc-writing.md)             |
| Explaining an unfamiliar codebase to a human      | [vibe-wiki.md](references/vibe-wiki.md)                 |

## Core Principles (always apply)

1. **Understand before you write.** Read the surrounding code and call sites first. A 30-second read prevents a 30-minute rewrite.
2. **Smallest change that solves the problem.** No drive-by refactors, no speculative abstractions, no "while I'm here" cleanups unless the leader asked.
3. **Match the codebase, not your preferences.** Style, naming, error handling, test layout — mirror what's already there.
4. **Never invent APIs.** If you're unsure a function/flag/package exists, grep the repo or check the docs. Don't guess.
5. **Honesty over confidence.** "I couldn't verify X" beats a hallucinated success every time.
6. **Verify before declaring done.** It compiles, relevant tests pass (or you said you couldn't run them), the diff matches the ask — nothing more, nothing less.

## Universal Anti-Patterns

- Mixing refactor + feature + format change in one edit.
- Adding error handling for cases that can't happen. Trust internal invariants; only validate at system boundaries (user input, network, disk, FFI).
- Wrapping internal calls in `try/catch` "to be safe" — that hides real bugs.
- Leaving debug prints, commented-out code, or `// TODO: removed X` tombstones.
- Bumping major versions of dependencies as a side effect of unrelated work.
- Running deploy / CI / cloud CLI commands without an explicit ask.
- Adding feature flags, config toggles, or backwards-compat shims unless required.

## Verification Gate (before reporting done)

- [ ] The change compiles / type-checks.
- [ ] Relevant tests pass, or you said honestly you couldn't run them.
- [ ] No unrelated files modified.
- [ ] No debug prints, commented-out code, or scratch files left behind.
- [ ] The diff matches what was asked — nothing more, nothing less.
- [ ] If UI: you actually exercised it in a browser, or said you couldn't.

If any box is unchecked, the task isn't done. Either finish it or report the gap honestly.
