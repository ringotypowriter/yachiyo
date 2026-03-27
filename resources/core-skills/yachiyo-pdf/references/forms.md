# Yachiyo PDF Forms Reference

## First decision

Determine which kind of form you are dealing with:

- **Interactive form**: the PDF exposes real fields that can be filled programmatically.
- **Flat form**: the PDF is just a page image or static drawing and must be annotated visually.

Do not assume. Inspect the document first.

## Interactive forms

Preferred workflow:

1. Inspect field names and field types.
2. Map user data to those fields explicitly.
3. Fill a copy of the PDF.
4. Re-open the result and verify the values were written.

Guidelines:

- Match by actual field identifier, not by guesswork from the visible label.
- Watch for checkboxes, radio groups, dropdowns, and multiline text fields.
- If a field value must be one of a fixed set, validate against the available options before writing output.

## Flat forms

Preferred workflow:

1. Render the page or inspect its coordinate system.
2. Identify the target positions for text, check marks, or signatures.
3. Write onto a copy of the PDF.
4. Render the output again and visually verify placement.

Guidelines:

- Use a consistent coordinate system for the whole job.
- If placement is approximate, say that explicitly.
- For multi-page forms, verify every changed page, not just the first one.

## When to stop and clarify

Stop and report the constraint instead of guessing when:

- the PDF is password protected
- the form is scanned and low quality
- visible labels do not match machine-readable field names
- the user data is ambiguous or incomplete

## Definition of done

A form-filling task is only done when:

- the output file exists
- the intended fields or marks are present
- the content is readable
- the placement is correct enough for the form’s real-world use
