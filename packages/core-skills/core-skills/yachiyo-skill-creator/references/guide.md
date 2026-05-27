# Yachiyo Skill Creator Guide

## Purpose

Use `yachiyo-skill-creator` for creating or updating reusable skills that teach Yachiyo how to handle a category of work.

The goal is not to write a giant handbook. The goal is to create a compact operational guide that triggers correctly and helps the agent do the job with minimal noise.

## Definition Of Done

- The skill has a clear folder under `~/.yachiyo/skills/custom/`.
- `SKILL.md` contains valid frontmatter and a practical body.
- Any referenced scripts or documents exist.
- The skill is small, readable, and focused on one job family.

## Recommended Folder Shape

Use the smallest structure that fits:

```text
~/.yachiyo/skills/custom/skill-name/
├── SKILL.md
└── references/
    └── guide.md
```

Add `scripts/` only when repeated deterministic execution is better than re-explaining the same workflow every time.

Avoid adding extra files like:

- `README.md`
- `CHANGELOG.md`
- `QUICKSTART.md`
- duplicate notes that restate `SKILL.md`

## How To Design The Trigger

The `description` field is the trigger surface. Make it specific enough that the runtime can pick the skill for the right jobs.

Good description traits:

- says what the skill is for
- includes representative tasks
- names the tool or domain when important
- avoids vague phrases like "general helper"

Bad pattern:

```yaml
description: Helps with many things.
```

Better pattern:

```yaml
description: Use this skill for browser automation with the `agent-browser` CLI, including opening pages, filling forms, taking screenshots, and verifying web flows.
```

## How To Write `SKILL.md`

Keep the entry file lean. It should answer four questions quickly:

1. When should this skill be used?
2. What is the normal workflow?
3. What defaults or guardrails matter?
4. How should success be verified?

That is usually enough.

Recommended shape:

```markdown
---
name: my-skill
description: Clear trigger description.
---

# My Skill

One-sentence use case.

Read [guide.md](references/guide.md) for the operating guide before non-trivial work.

## Stable Workflow

...

## Good Defaults

...

## Verification

...
```

## When To Add References

Put detail into `references/` when:

- the workflow has multiple modes
- command examples would make `SKILL.md` noisy
- the domain has enough nuance that the agent needs a playbook

Do not create references just because you can. If the whole skill fits comfortably in one file, keep it in one file.

## When To Add Scripts

Add a script only when at least one of these is true:

- the same command sequence would otherwise be re-derived often
- exact output structure matters
- the work is easier to verify through a deterministic tool

If plain instructions are enough, skip the script.

## Bundled Core Skill Rules For Yachiyo

When creating a Yachiyo skill:

- place it under `~/.yachiyo/skills/custom/<skill-name>/`
- keep the structure compact and consistent
- treat it as a real user-visible skill, not a placeholder in some other directory
- keep the content clean-room and Yachiyo-native rather than mirroring another project's wording

## Editing Existing Skills

When updating an existing skill:

1. Preserve its purpose.
2. Remove repetition before adding more text.
3. Prefer sharpening the trigger description over adding bulk.
4. Keep references in sync with the entry file.

If a skill feels bloated, the right fix is usually to delete or move detail, not to add another layer.

## Review Checklist

Before finishing, check:

- folder name matches the intended skill name
- frontmatter `name` matches the exported skill identity
- `description` is concrete and trigger-friendly
- every referenced path exists
- the skill is shorter and clearer than a generic documentation dump
