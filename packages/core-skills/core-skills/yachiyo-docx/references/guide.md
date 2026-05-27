# Yachiyo DOCX Guide

## Purpose

Use `yachiyo-docx` for Word document creation, inspection, template filling, and controlled edits.

## Stable Workflow

1. Inspect the document package first.
2. Decide whether the job is:
   - content extraction
   - targeted text replacement
   - template filling
   - table or image update
   - full document generation
3. Preserve the original structure unless redesign is explicitly requested.
4. Save to a new `.docx` by default.
5. Re-open and verify the touched content.

## Inspector Script

Run this before editing an existing `.docx`:

```bash
python3 resources/core-skills/yachiyo-docx/scripts/docx_inspect.py path/to/file.docx --json
```

What it reports:

- paragraph and table counts
- image, header, and footer presence
- comments and track-change markers
- hyperlink count
- placeholder tokens like `{{name}}` or `${company}`
- sample text for quick sanity checks

For simple template filling where placeholders live inside ordinary text nodes:

```bash
python3 resources/core-skills/yachiyo-docx/scripts/docx_fill_template.py \
  template.docx filled.docx \
  --map values.json
```

Use this only when the placeholders are already present and you want a structure-preserving fill, not a redesign.

## Route Selection

- Use `pandoc` for plain content extraction or quick conversions.
- Use ZIP plus XML inspection for precise debugging and template-safe edits.
- Use a document library for new file generation with headings, tables, and images.
- Use LibreOffice only when you need conversion or a visual check.

## Reliability Rules

- Do not flatten a styled source into plain text unless that is the actual request.
- When a template is provided, fill it. Do not redesign it.
- If comments, revisions, headers, or footers matter, inspect the package and verify them explicitly.
- If a conversion may shift layout, say so before relying on it.

## Definition Of Done

- Output file exists.
- Expected text, placeholders, or replaced content are correct.
- Important structure survived: headings, tables, images, headers, footers, or comments as applicable.
- A follow-up read confirms the edited document is coherent.
