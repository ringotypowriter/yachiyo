---
name: yachiyo-skill-creator
description: Use this skill when the user wants to create or update a Yachiyo skill. Create Yachiyo skills under `~/.yachiyo/skills/custom/`, define a clear trigger description, keep `SKILL.md` lean, and add references or scripts only when they materially help.
license: Original clean-room skill for Yachiyo. No third-party skill content included.
---

# Yachiyo Skill Creator

Use this skill when the user asks to create, revise, bundle, or clean up a skill.

Read [guide.md](references/guide.md) before creating a non-trivial skill or reorganizing an existing one.

## Stable Workflow

1. Identify the skill's job and trigger conditions.
2. Choose the smallest folder structure that supports that job.
3. Write a short `SKILL.md` with clear frontmatter and operating instructions.
4. Move deeper details into `references/` only when they are actually useful.
5. Add scripts only when deterministic execution matters more than prose.
6. Verify the skill path, frontmatter, and bundled files before finishing.

## Good Defaults

- Keep the frontmatter description concrete about what the skill is for.
- Keep `SKILL.md` short and action-oriented.
- Prefer one guide file over many tiny reference files.
- Do not create README-style filler documents.
- Place Yachiyo skills under `~/.yachiyo/skills/custom/<skill-name>/`.

## Output Rules

- Create only the files the skill genuinely needs.
- Use clean, stable names for skill folders and references.
- Avoid copying third-party skill text directly into bundled Yachiyo skills.
- For Yachiyo skills, write them directly into `~/.yachiyo/skills/custom/`.

## Verification

Before finishing:

- Confirm `SKILL.md` exists in the skill root.
- Confirm the frontmatter has at least `name` and `description`.
- Confirm any referenced files actually exist.
- Confirm the skill sits under `~/.yachiyo/skills/custom/<skill-name>/`.
