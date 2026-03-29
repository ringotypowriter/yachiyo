---
name: yachiyo-browser
description: Use this skill for browser automation with the `agent-browser` CLI: opening pages, taking snapshots, clicking and filling elements, handling login state, capturing screenshots, extracting page data, and verifying web flows. Re-snapshot after page changes, use isolated sessions when needed, and always close the browser session when done.
---

# Yachiyo Browser

Use this skill when the user wants browser automation through `agent-browser`.

Read [guide.md](references/guide.md) for the operating guide before non-trivial web work.

## Stable Workflow

1. Open the target page.
2. Wait for load or the specific content you need.
3. Take a snapshot to discover fresh element refs.
4. Interact with the page using those refs.
5. Re-snapshot after navigation or visible DOM changes.
6. Verify the result with text, URL, screenshot, diff, or download checks.
7. Close the session when done.

## Good Defaults

- Prefer `snapshot -i` before interacting.
- Prefer explicit waits over fixed sleeps.
- Use named sessions for multi-site or concurrent work.
- Save or reuse auth state only when the task actually needs login.
- Use annotated screenshots when visual layout matters more than text output.

## Output Rules

- Report the concrete page state you verified, not just the commands you ran.
- Save screenshots, PDFs, HAR files, or downloads to explicit paths when the task needs artifacts.
- Do not leave long-lived browser sessions running unless the user asked for persistence.

## Verification

Before finishing:

- Confirm the final URL or visible text matches the requested outcome.
- Confirm any expected file, screenshot, or download exists.
- If the task changed the page, verify the effect with a fresh snapshot, `get`, or `diff`.
- If login state was created temporarily, make sure it is either stored intentionally or cleaned up.
