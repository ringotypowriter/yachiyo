---
name: yachiyo-pptx
description: Use this skill for presentation work such as reading `.pptx` files, extracting slide text, editing existing decks, creating new slide decks, updating speaker notes, and preserving template structure. Start with the narrowest reliable workflow, keep the original deck untouched unless asked otherwise, and verify slide output before finishing.
license: Original clean-room skill for Yachiyo. No third-party skill content included.
---

# Yachiyo PPTX

Use this skill when the user wants to inspect, update, or create a presentation.

Read [guide.md](references/guide.md) for the full workflow. Use the inspector script before editing an existing deck:

```bash
python3 resources/core-skills/yachiyo-pptx/scripts/pptx_inspect.py path/to/file.pptx --json
```

## Workflow

1. Identify the task:
   - Extract slide text or notes
   - Update an existing deck
   - Create a new deck
   - Reorder, split, or combine slides
   - Replace text, charts, or images
2. Choose the narrowest tool that fits.
3. Save to a new file by default.
4. Verify the result before reporting back.

## Tool Selection

- slide text extraction tools: reading content quickly
- PPTX unzip plus XML inspection: precise debugging or structured edits
- a presentation generation library: creating or rewriting decks programmatically
- PDF or image export: visual verification when layout matters

## Editing Rules

- Preserve the existing template, theme, and layout unless the user asked for redesign.
- Change only the slides that need to change.
- If slide visuals matter, do not rely on text extraction alone.
- When creating a new deck, keep the structure intentional and concise rather than filling slides with generic bullets.

## Output Rules

- Do not overwrite the source `.pptx` unless the user explicitly asks for it.
- Use explicit filenames such as `updated-deck.pptx` or `summary-deck.pptx`.
- If a conversion or regeneration may alter layout fidelity, state that before doing it.

## Verification

Before finishing:

- Confirm the output file exists.
- Confirm the expected slide count.
- Re-check changed slide text, titles, and notes.
- If layout matters, export a visual preview and spot-check the changed slides.
