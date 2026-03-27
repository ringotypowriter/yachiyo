---
name: yachiyo-docx
description: Use this skill for Word document work such as reading `.docx` files, extracting content, editing existing documents, generating new `.docx` files, replacing text, updating tables, handling images, and preserving document structure. Prefer the smallest reliable workflow, keep the original file unchanged unless asked otherwise, and verify the result before finishing.
license: Original clean-room skill for Yachiyo. No third-party skill content included.
---

# Yachiyo DOCX

Use this skill when the user wants to create, inspect, modify, or transform a Word document.

Read [guide.md](references/guide.md) for the full workflow. Use the inspector script before editing an existing document:

```bash
python3 resources/core-skills/yachiyo-docx/scripts/docx_inspect.py path/to/file.docx --json
```

## Workflow

1. Identify the task:
   - Read text or structure
   - Edit an existing document
   - Create a new document
   - Replace images, tables, or sections
   - Convert formats
2. Choose the narrowest tool that fits.
3. Save to a new file by default.
4. Verify the output before reporting back.

## Tool Selection

- `pandoc`: extracting text or converting document content
- DOCX unzip plus XML inspection: precise debugging or targeted edits
- a DOCX generation library: creating new documents with headings, tables, and images
- LibreOffice conversion: format conversion or visual validation when needed

## Editing Rules

- Preserve the existing document structure unless the user asked for redesign.
- Keep styles consistent with the source document.
- Do not flatten the document into plain text unless the user only wants content extraction.
- For complex edits, inspect the resulting document instead of assuming the XML change was safe.

## Output Rules

- Do not overwrite the source `.docx` unless the user explicitly asks for it.
- Use explicit filenames such as `updated.docx`, `filled-template.docx`, or `report.docx`.
- If formatting may shift because of conversion, say that clearly.

## Verification

Before finishing:

- Confirm the output file exists.
- Re-open the result with the chosen tool and check that the expected content is present.
- If the task touched formatting, verify a sample of headings, tables, images, or page structure.
- If the task involved conversion, confirm the target format opens and contains the expected content.
