# Doc Writing

Documentation is a product. It has users, it has a job, and it can fail at that job. Write docs the way you'd write code: with a clear audience, a clear purpose, and no padding.

## Know Your Reader

Before writing one line, name the reader and what they're trying to do:

- **Newcomer in the first 5 minutes** — wants to know what this is and whether to keep reading. → README intro / one-paragraph summary.
- **Someone trying to install / run it** — wants the shortest happy path. → Quickstart.
- **Someone using the API** — knows the domain, wants reference. → API docs.
- **Someone learning the concepts** — knows nothing, wants to build a mental model. → Tutorial / guide.
- **Someone debugging at 2am** — wants a specific answer to a specific question. → Troubleshooting / FAQ.

Different readers want different docs. Don't try to write one document that serves all five.

## The Four Doc Types (Diátaxis)

This framework is a useful lens. Don't mix the types:

| Type            | Reader's question         | Style                            |
| --------------- | ------------------------- | -------------------------------- |
| **Tutorial**    | "Teach me from scratch"   | Hand-held, narrative, can't fail |
| **How-to**      | "I need to accomplish X"  | Goal-oriented, no theory         |
| **Reference**   | "What does X do exactly?" | Dry, complete, indexed           |
| **Explanation** | "Why does this exist?"    | Discursive, context, tradeoffs   |

A README mixes them, but for a reason — and even there, keep them in separate sections.

## The Anatomy of a Good README

In rough order:

1. **Name + one-line description.** What is this, in 12 words.
2. **Why it exists / what problem it solves.** One paragraph.
3. **Quickstart.** The shortest path from "git clone" to "it ran."
4. **Basic usage example.** A real, copy-pasteable snippet.
5. **Link to deeper docs.** Don't put everything in the README.
6. **Contributing / license / status.** Bottom of the page.

What doesn't belong in the README:

- Full API reference (link to it).
- Architecture deep-dives (link to them).
- Changelog (separate file).
- Marketing copy.

## Writing Style

- **Plain language over precise jargon** when both work.
- **Active voice.** "Run the migration" beats "the migration should be run."
- **Imperative for instructions.** "Click Save" not "you can click Save."
- **Show, don't tell.** A 4-line code example beats a paragraph of prose explaining it.
- **Front-load the important thing.** Reader gives up after one paragraph; make it count.
- **No filler.** "It is important to note that…" → just say it.
- **Define terms once, on first use.** Don't assume readers came in order.

## Code Examples

- **Real, runnable code.** Pseudo-code is a last resort.
- **Minimal but complete.** Imports included if a copy-paste won't work without them.
- **One idea per example.** Don't show error handling, async, and config all at once if the point is config.
- **Output shown when it helps.** Reader needs to see what success looks like.
- **Versioned.** Examples that work for v2 break in v3. Note the version or update the example.

## Inline Code Comments

A separate beast from prose docs. The rule: comments answer **why**, never **what**.

Bad:

```python
# Loop through items
for item in items:
    # Increment counter
    counter += 1
```

Good:

```python
# Use a manual counter rather than len(items) because the upstream API
# sometimes returns a sentinel item we want to skip but still count.
for item in items:
    if item.kind == "sentinel":
        continue
    counter += 1
```

If a comment exists to clarify obvious code, the code probably needs better names instead.

## API Reference

For each function/method/endpoint, include:

- One-line description.
- Parameters: name, type, whether required, what it means.
- Return value: type and meaning.
- Errors thrown / status codes.
- A short example.
- Cross-links to related APIs.

Generated from doc comments where possible (Sphinx, godoc, rustdoc, javadoc, TSDoc, OpenAPI). Hand-maintained reference docs always drift.

## Maintenance

Docs decay. Fight back:

- Treat doc changes as part of the code change. A PR that changes behavior should update docs in the same PR.
- Date "last updated" only when it's actually meaningful (releases, deprecations).
- Run code examples in CI when feasible — at minimum, lint that they compile.
- Delete docs for removed features. Stale docs are worse than no docs.

## Anti-Patterns

- **Writing docs to feel productive** when you should be writing code (or vice versa).
- **Comprehensive but unfindable.** A 200-page wiki nobody reads helps nobody.
- **Documentation theater.** Auto-generated docs that just restate the function signature add nothing.
- **Promising future features.** "Coming soon" sections rot into landmines.
- **AI-flavored padding.** "In this section, we will explore…" — just explore. Skip the meta.
- **Mixing doc types.** A reference page that detours into philosophy. A tutorial that turns into an API dump.
