---
name: yachiyo-pdf
description: Use this skill for PDF work such as reading text, extracting tables, merging files, splitting pages, rotating pages, converting pages to images, creating simple PDFs, and filling forms. Start with the smallest reliable tool, preserve the source file unless the user asks to overwrite it, and verify the output before finishing.
license: Original clean-room skill for Yachiyo. No third-party skill content included.
---

# Yachiyo PDF

Use this skill when the user asks to inspect, transform, generate, or fill a PDF.

Read [guide.md](references/guide.md) for the full operating guide. Use the inspector script before non-trivial work:

```bash
python3 resources/core-skills/yachiyo-pdf/scripts/pdf_inspect.py path/to/file.pdf --json
```

## Workflow

1. Identify the job:
   - Read text or metadata
   - Extract tables
   - Merge, split, rotate, or reorder pages
   - Render pages to images
   - Create a new PDF
   - Fill a form
2. Choose the narrowest tool that fits the task.
3. Write outputs to a new file by default.
4. Verify the result before reporting back.

## Tool Selection

- `pypdf`: merging, splitting, rotating, metadata, simple page manipulation
- `pdfplumber`: text and table extraction when layout matters
- `pdftotext`: fast plain-text extraction from text PDFs
- `qpdf`: structural operations and PDF validation
- `reportlab` or `pdf-lib`: creating PDFs from scratch
- OCR tools: only when the PDF is image-based and normal extraction fails

Read [tooling.md](references/tooling.md) for concrete tool guidance.

## Form Filling

For forms, first determine whether the PDF contains interactive fields.

- If it has fillable fields, prefer field-based filling.
- If it does not, place text or marks onto a copy of the document.

Read [forms.md](references/forms.md) before implementing form filling.

## Output Rules

- Do not overwrite the source PDF unless the user explicitly asks for it.
- Preserve page order unless the task requires changing it.
- Keep filenames explicit, such as `merged.pdf`, `rotated-page-1.pdf`, or `form-filled.pdf`.
- If a step is lossy, say so before doing it.

## Verification

Before finishing:

- Confirm the output file exists.
- Confirm page count when pages were added, removed, merged, or split.
- Spot-check text extraction or rendered pages when the task depends on content accuracy.
- If the task is form filling, verify the expected fields or visible marks appear in the output.

## Escalation

- If the PDF appears scanned, encrypted, corrupted, or image-only, say that explicitly and switch to OCR, password handling, or repair tooling as needed.
- If a requested operation needs a dependency that is not installed, explain the missing tool and stop instead of improvising a fragile workaround.
