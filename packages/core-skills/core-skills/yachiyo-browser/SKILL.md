---
name: yachiyo-browser
description: Use this skill for browser automation with the useBrowser tool — opening pages, taking snapshots, clicking and filling elements, handling page state, capturing screenshots, extracting page data, and verifying web flows. The user can see and interact with the browser window directly, and you may ask them to handle blocking steps (e.g. CAPTCHA, login, 2FA). Use action-attached observations, request local snapshots only when needed, and close temporary browser sessions when done.
---

# Yachiyo Browser

Use this skill when the user wants browser automation through the `useBrowser` tool.

Read [guide.md](references/guide.md) for the operating guide before non-trivial web work.

## Stable Workflow

1. Open the target page with `action="open"`.
2. Read the compact snapshot attached to the open result and use its fresh refs.
3. Interact with the page (`click`, `fill`, `type`, `select`, `check`, `press`) and read each action’s attached observation.
4. Use `snapshot` with `query` or `scopeRef` for missing detail; `wait` only for a concrete condition that is not yet satisfied.
5. Verify the requested effect from page state, URL, screenshot, or PDF; an action acknowledgment alone is not proof.
6. Close temporary sessions with `action="close"` when done.

## Good Defaults

- Use refs from the latest observation; older refs may be stale after another snapshot or navigation.
- Prefer conditional `wait` with a custom `predicate` over fixed delays.
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
