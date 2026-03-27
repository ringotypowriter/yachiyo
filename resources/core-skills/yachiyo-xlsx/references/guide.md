# Yachiyo XLSX Guide

## Purpose

Use `yachiyo-xlsx` for spreadsheet inspection, cleanup, editing, generation, and validation.

## Stable Workflow

1. Inspect the workbook first.
2. Decide whether the job is:
   - read or summarize
   - clean or reshape
   - add formulas or formatting
   - update a template workbook
   - generate a new workbook
3. Keep source structure intact unless the user asked to reorganize it.
4. Save to a new workbook by default.
5. Verify touched sheets, formulas, and major workbook features.

## Inspector Script

Run this before a non-trivial workbook edit:

```bash
python3 resources/core-skills/yachiyo-xlsx/scripts/xlsx_inspect.py path/to/file.xlsx --json
```

What it reports:

- sheet count and sheet names
- per-sheet dimensions and row-count hints
- formula counts
- merged ranges, data validations, and table parts
- chart, drawing, and external-link presence
- macro and calc-chain markers

For safe extraction of one sheet to CSV without depending on an office suite:

```bash
python3 resources/core-skills/yachiyo-xlsx/scripts/xlsx_export_sheet_csv.py \
  workbook.xlsx out.csv \
  --sheet Summary
```

## Route Selection

- Use `pandas` for tabular cleanup and reshape work.
- Use workbook-level libraries for formulas, styles, charts, and precise cell edits.
- Use an office recalc path only when formula recalculation or visual confirmation is needed.

## Reliability Rules

- Do not silently replace formulas with static values.
- Watch for macros, external links, and workbook features that a chosen library may strip.
- Verify changed formulas on touched sheets instead of trusting the write step.
- Keep filenames explicit so the user can compare old and new workbooks safely.

## Definition Of Done

- Output workbook exists.
- Expected sheets are present.
- Touched formulas and cell regions look correct.
- No obvious workbook feature was lost accidentally.
