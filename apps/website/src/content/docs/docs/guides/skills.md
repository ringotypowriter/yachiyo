---
title: Skills
description: How Yachiyo discovers skills, which directories it scans, and how to write your own SKILL.md.
---

A skill is a folder with a `SKILL.md` in it. That is the entire format. No
manifest, no runtime, no registration call, no server to keep alive.

The agent sees only skill **names and descriptions** in its context. When one
looks relevant it calls `skillsRead` to pull in the full text. So a skill costs
you one line of context until the moment it is actually needed — which is why
you can have dozens installed without drowning the model.

## Where skills come from

Yachiyo scans a fixed set of directories. For each registered workspace:

| Directory                      | Auto-enabled |
| ------------------------------ | ------------ |
| `<workspace>/.yachiyo/skills/` | yes          |
| `<workspace>/.codex/skills/`   | no           |
| `<workspace>/.agents/skills/`  | no           |
| `<workspace>/.claude/skills/`  | no           |

And in your home directory:

| Directory            | Auto-enabled |
| -------------------- | ------------ |
| `~/.yachiyo/skills/` | yes          |
| `~/.codex/skills/`   | no           |
| `~/.agents/skills/`  | no           |
| `~/.claude/skills/`  | no           |

Skills written for Claude Code, Codex, or other agent tools are picked up where
they already sit — you do not have to move or convert anything. They just are not
enabled by default; flip them on in **Settings → Capabilities → Skills**.

Under the Yachiyo home, two subdirectories mean different things:

- `~/.yachiyo/skills/core/` — bundled skills, **re-extracted on every app
  launch**. Edits here are overwritten.
- `~/.yachiyo/skills/custom/` — yours. This is where to put your own work.

When two skills share a name, the first root wins — workspace roots are scanned
before home roots, so a project can shadow a global skill with its own version.
`node_modules` and VCS directories are skipped during the scan.

## Which skills are active

Not a single list — the active set is assembled from three inputs:

1. Every **auto-enabled** skill (anything under a `.yachiyo/skills` root, in your
   home directory or a workspace), unless it appears in `skills.disabled`.
2. Plus anything named explicitly in `skills.enabled` — this is how skills from
   `~/.claude/skills` and friends get switched on.
3. Unless the composer overrides the set for a specific run, in which case that
   override is the whole truth and the settings above are ignored.

So the bundled skills work out of the box, external ones are opt-in, and turning
a bundled skill off means adding it to `disabled` rather than removing it from
`enabled`.

**Settings → Capabilities → Skills** shows everything discoverable with a toggle
each, which is the sane way to manage this. The underlying keys:

```bash
yachiyo config get skills.enabled
yachiyo config get skills.disabled
```

## Writing a skill

Ask for one:

> Write me a skill for drafting release notes from a git log. It should group
> commits by type and skip internal churn.

The bundled `yachiyo-skill-creator` skill covers the conventions — where custom
skills live, how to write a trigger description, when to split content into
reference files — so the assistant produces something that follows the house
style instead of guessing.

That is the recommended path. The format is simple enough to hand-write, though,
so here is what it produces.

### The format

A directory and a `SKILL.md`:

```markdown title="~/.yachiyo/skills/custom/release-notes/SKILL.md"
---
name: release-notes
description: Use when drafting release notes from a git log — groups commits by type, writes user-facing summaries, and skips internal churn.
---

# Release Notes

Draft release notes from commit history.

## Process

1. Run `git log <last-tag>..HEAD --oneline` to get the range.
2. Group commits by conventional-commit type (`feat`, `fix`, `perf`).
3. Drop `chore`, `refactor`, and test-only commits — they are not user-facing.
4. Write one line per surviving commit, in the user's language, describing the
   effect rather than the implementation.

## Rules

- Never invent a change that is not in the log.
- If a commit message is too vague to summarize, read the diff.
```

Two frontmatter fields matter:

- **`name`** — how the skill is referenced. Falls back to the first `#` heading,
  then the directory name.
- **`description`** — falls back to the first paragraph of the body.

The description is the only thing the agent sees before deciding to load the
skill, so write it as a **trigger**, not a summary. "Use when drafting release
notes from a git log" earns its keep; "Release notes helper" does not.

### Supporting files

Anything else in the directory is fair game — reference documents, scripts,
templates. Point at them from `SKILL.md` with relative links:

```markdown
Read [references/tone.md](references/tone.md) before writing the summaries.
```

The agent reads those with the normal `read` tool when it needs them. This keeps
`SKILL.md` short while letting a skill carry real depth — and it is the pattern
the bundled skills use.

If `SKILL.md` itself gets very large, `skillsRead` stops inlining it and tells
the agent to open the file directly instead. Treat that as the signal to move
detail into references.

## Bundled skills

| Skill                      | What it covers                                                          |
| -------------------------- | ----------------------------------------------------------------------- |
| `yachiyo-help`             | The `yachiyo` CLI — every namespace, plus install troubleshooting.      |
| `yachiyo-docs`             | These docs. Reads them live, so answers track the current release.      |
| `yachiyo-code`             | Coding discipline reference; a hub that points at task-specific guides. |
| `yachiyo-browser`          | Browser automation via the `useBrowser` tool.                           |
| `yachiyo-kagete`           | Native macOS window automation — click, type, drag, screenshot any app. |
| `yachiyo-macos-apps`       | Mail, Notes, Reminders, and Calendar via AppleScript.                   |
| `yachiyo-macos-screenshot` | Screen, window, and region capture.                                     |
| `yachiyo-ghostty`          | Inspect and drive Ghostty terminal sessions.                            |
| `yachiyo-pdf`              | Read, merge, split, rotate, rasterize, and fill PDFs.                   |
| `yachiyo-docx`             | Word documents — read, edit, generate.                                  |
| `yachiyo-xlsx`             | Spreadsheets and CSV/TSV — clean, edit, formula, validate.              |
| `yachiyo-pptx`             | Presentations — read decks, edit slides, keep templates intact.         |
| `yachiyo-zotero`           | Query a local Zotero library over its HTTP server.                      |
| `yachiyo-skill-creator`    | Conventions for writing new skills.                                     |

Several of these are macOS-only, which the skill states up front.

## Debugging discovery

If a skill does not show up, ask:

> I put a skill at `~/.yachiyo/skills/custom/my-skill/`, but you don't seem to
> see it. Work out why.

It can list what it currently has, read the file, and check the usual causes
faster than you can.

Those causes, for reference:

1. The file is not named exactly `SKILL.md`, or it sits at a scanned root rather
   than in a directory beneath one, or it is nested inside `node_modules`.
2. The frontmatter does not parse — it must open on line one with `---`, and both
   the key and the value on a line must be non-empty.
3. A skill in an earlier-scanned root already claims that name.
4. It is discovered but switched off. Check **Settings → Capabilities → Skills**.
