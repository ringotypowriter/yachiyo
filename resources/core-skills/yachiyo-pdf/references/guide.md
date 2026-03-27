# Yachiyo PDF Guide

## Purpose

Use `yachiyo-pdf` for practical PDF jobs:

- inspect a PDF before touching it
- extract text or tables
- merge, split, rotate, or reorder pages
- fill interactive or flat forms
- create a simple generated PDF

## Stable Workflow

1. Inspect the file first.
2. Decide whether the job is:
   - text extraction
   - table extraction
   - structural editing
   - form filling
   - PDF generation
3. Use the narrowest tool that can finish the job.
4. Write to a new file unless the user asked to overwrite.
5. Verify the output with page count or visible spot checks.

## Inspector Script

Run this before a non-trivial task:

```bash
python3 resources/core-skills/yachiyo-pdf/scripts/pdf_inspect.py path/to/file.pdf --json
```

What it helps with:

- confirms the file looks like a PDF
- gets page count when possible
- checks whether text extraction works
- flags likely AcroForm usage
- suggests whether the next route should be text tools, form tools, or OCR

For interactive forms, list likely field names first:

```bash
python3 resources/core-skills/yachiyo-pdf/scripts/pdf_list_form_fields.py path/to/form.pdf --json
```

## Route Selection

- Use `pdftotext` for fast plain-text extraction from text PDFs.
- Use `pdfplumber` when table or layout fidelity matters.
- Use `pypdf` or `qpdf` for merge, split, rotate, reorder, or metadata work.
- Use visible placement only when the form is flat or text extraction clearly fails.
- Switch to OCR only after ordinary extraction fails.

## Reliability Rules

- Never assume a form is interactive. Inspect first.
- Never assume a PDF is text-based. Verify extraction first.
- If encryption, corruption, or image-only pages block the task, state that directly.
- Verify the changed pages, not just file existence.

## Definition Of Done

- Output file exists.
- Page count matches the requested transformation.
- Extracted or filled content is present.
- If the task was visual, a rendered or textual spot check confirms the result.
