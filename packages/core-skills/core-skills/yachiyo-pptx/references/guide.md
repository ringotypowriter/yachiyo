# Yachiyo PPTX Guide

## Purpose

Use `yachiyo-pptx` for reading, editing, or generating PowerPoint decks while preserving layout intent.

## Stable Workflow

1. Inspect the deck first.
2. Decide whether the job is:
   - text extraction
   - targeted slide edits
   - slide reordering or combining
   - image or chart replacement
   - full deck generation
3. Preserve theme and layout unless the user explicitly asked for redesign.
4. Save to a new `.pptx` by default.
5. Verify changed slides, not just the file container.

## Inspector Script

Run this before editing a deck:

```bash
python3 resources/core-skills/yachiyo-pptx/scripts/pptx_inspect.py path/to/file.pptx --json
```

What it reports:

- slide count
- per-slide title and sample text
- shape and table counts
- notes-slide count
- chart, image, and layout presence

For narrow content updates where the slide layout should stay intact:

```bash
python3 resources/core-skills/yachiyo-pptx/scripts/pptx_replace_text.py \
  input.pptx output.pptx \
  --from "Old title" \
  --to "New title"
```

## Route Selection

- Use text extraction for fast understanding only.
- Use ZIP plus XML inspection when a layout-sensitive bug needs precise diagnosis.
- Use a presentation library for deliberate slide creation or editing.
- Export a visual preview when layout fidelity matters.

## Reliability Rules

- Never trust text extraction alone for visual tasks.
- Touch only the slides that need to change.
- If a regeneration route may alter the theme or spacing, warn before using it.
- Keep slide titles concise and check speaker notes separately when they matter.

## Definition Of Done

- Output deck exists.
- Slide count matches expectations.
- Changed slide titles and body text are correct.
- Layout-sensitive changes were visually spot-checked.
