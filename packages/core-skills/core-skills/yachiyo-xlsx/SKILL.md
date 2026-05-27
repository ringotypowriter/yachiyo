---
name: yachiyo-xlsx
description: Use this skill for spreadsheet work such as reading `.xlsx`, `.xlsm`, `.csv`, or `.tsv` files, cleaning tabular data, editing workbooks, creating spreadsheets, adding formulas, formatting sheets, and validating output. Prefer the smallest reliable workflow, keep source files untouched unless asked otherwise, and verify formulas and structure before finishing.
license: Original clean-room skill for Yachiyo. No third-party skill content included.
---

# Yachiyo XLSX

Use this skill when the user wants to inspect, clean, modify, or generate a spreadsheet.

Read [guide.md](references/guide.md) for the full workflow. Use the inspector script before non-trivial workbook edits:

```bash
python3 resources/core-skills/yachiyo-xlsx/scripts/xlsx_inspect.py path/to/file.xlsx --json
```

## Workflow

1. Identify the task:
   - Read or summarize workbook contents
   - Clean or reshape tabular data
   - Add columns, formulas, formatting, or charts
   - Create a new spreadsheet
   - Convert between spreadsheet-friendly formats
2. Choose the narrowest tool that fits.
3. Save to a new file by default.
4. Verify the output before reporting back.

## Tool Selection

- `pandas`: reading, cleaning, reshaping, and exporting tabular data
- spreadsheet libraries: cell-level workbook editing, formulas, formatting, and charts
- LibreOffice or equivalent recalc path: formula recalculation and visual verification when needed

## Editing Rules

- Preserve workbook structure and sheet names unless the user asked to reorganize them.
- Keep formulas explicit and readable.
- Do not silently replace formulas with values unless the user wants a static export.
- When editing templates, follow the existing formatting rather than imposing a new style.

## Output Rules

- Do not overwrite the source workbook unless the user explicitly asks for it.
- Use explicit filenames such as `cleaned.xlsx`, `analysis.xlsx`, or `forecast.xlsx`.
- If macros, external links, or unsupported features may be affected, say that clearly before proceeding.

## Verification

Before finishing:

- Confirm the output file exists.
- Confirm the expected sheet names and major tabs are present.
- Re-open the workbook and verify changed cells, formulas, and formats on the touched sheets.
- If formulas were added or changed, verify they recalculate without obvious errors.
