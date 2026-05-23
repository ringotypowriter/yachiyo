---
name: yachiyo-browser
description: Use this skill for browser automation with the useBrowser tool — opening pages, taking snapshots, clicking and filling elements, handling page state, capturing screenshots, extracting page data, and verifying web flows. The user can see and interact with the browser window directly, and you may ask them to handle blocking steps (e.g. CAPTCHA, login, 2FA). Re-snapshot after page changes, use isolated sessions when needed, and always close the browser session when done.
---

# Yachiyo Browser

Use this skill when the user wants browser automation through the `useBrowser` tool.

Read [guide.md](references/guide.md) for the operating guide before non-trivial web work.

## Stable Workflow

1. Open the target page with `action="open"`.
2. Wait for load or specific content with `action="wait"`.
3. Take a snapshot with `action="snapshot"` to discover fresh element refs.
4. Interact with the page using those refs (`click`, `fill`, `type`, `select`, `check`, `press`).
5. Re-snapshot after navigation or visible DOM changes.
6. Verify the result with text, URL, screenshot, or PDF.
7. Close the session with `action="close"` when done.

## Good Defaults

- Prefer `snapshot` before interacting.
- Prefer explicit waits with custom `predicate` over fixed delays.
- Use named `session` values for multi-site or concurrent work.
- Cookies and storage are shared across sessions via a single global browser profile.
- Save screenshots and PDFs to explicit filenames when artifacts are needed.

## Output Rules

- Report the concrete page state you verified, not just the actions you took.
- Save screenshots and PDFs with explicit `fileName` values when the task needs artifacts.
- Do not leave long-lived browser sessions running unless the user asked for persistence.

## Verification

Before finishing:

- Confirm the final URL or visible text matches the requested outcome.
- Confirm any expected screenshot or PDF file exists in the workspace.
- If the task changed the page, verify the effect with a fresh `snapshot`, `getUrl`, or `getTitle`.
