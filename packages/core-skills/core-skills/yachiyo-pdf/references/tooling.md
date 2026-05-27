# Yachiyo PDF Tooling Reference

## Choose the simplest tool first

- Use `pdftotext` when the goal is fast text extraction from a normal text PDF.
- Use `pdfplumber` when the layout, table structure, or word positions matter.
- Use `pypdf` for page-level edits such as merge, split, rotate, reorder, or metadata inspection.
- Use `qpdf` when you need validation, repair attempts, encryption handling, or precise page selection from the command line.
- Use `reportlab` or `pdf-lib` when creating a new PDF is easier than editing an existing one.

## Practical defaults

### Read text

- Try `pdftotext` first for speed.
- If output is incomplete or poorly ordered, switch to `pdfplumber`.
- If both fail and the pages are image-based, use OCR.

### Extract tables

- Start with `pdfplumber`.
- Verify a sample of rows instead of assuming the grid was parsed correctly.

### Merge or split

- Use `pypdf` in scripts.
- Use `qpdf` for direct command-line page selection or validation afterward.

### Rotate or reorder pages

- Use `pypdf` for scripted transformations.
- Re-check page count and rotation on the changed pages.

### Render pages to images

- Prefer a renderer that preserves page order and predictable filenames.
- Use PNG when clarity matters more than file size.
- Use JPEG only when the user prefers smaller files and some loss is acceptable.

### Create a PDF

- Use `reportlab` for straightforward generated documents.
- Use `pdf-lib` when the task already lives in a JavaScript workflow.

## Reliability rules

- Keep the original file untouched unless asked otherwise.
- Name outputs by action, not by vague suffixes.
- Validate page count after structural edits.
- If an operation fails because the PDF is malformed, say that directly and try a repair-oriented tool instead of silently producing partial output.
