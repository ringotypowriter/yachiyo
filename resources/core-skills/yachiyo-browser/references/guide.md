# Yachiyo Browser Guide

## Purpose

Use `yachiyo-browser` for practical browser work with the `useBrowser` tool:

- open and inspect websites
- click, type, select, and submit forms
- capture screenshots or PDFs
- extract visible content via snapshots
- verify UI flows and page changes
- work with authenticated sessions when needed

The browser is a headful Electron BrowserWindow. Sessions are scoped to the current conversation, but cookies and local storage are shared via a single global browser profile.

## Definition Of Done

- The requested page or flow was actually exercised.
- The final state was verified with a fresh snapshot, URL check, text check, screenshot, or PDF.
- Any output artifact exists where expected.
- The session was closed unless the task explicitly needed it left open.

## Core Loop

Treat browser work as a repeatable loop:

1. Open the page.
2. Wait until it is ready.
3. Snapshot to get refs.
4. Interact using refs.
5. Re-snapshot after anything that changes the page.
6. Verify the result.

Typical sequence:

```json
{ "action": "open", "url": "https://example.com" }
{ "action": "wait" }
{ "action": "snapshot" }
```

If the snapshot shows refs like `@1` and `@2`, use them directly:

```json
{ "action": "fill", "ref": "@1", "text": "user@example.com" }
{ "action": "click", "ref": "@2" }
{ "action": "wait" }
{ "action": "snapshot" }
```

## Element Refs

Refs like `@1` are session-local handles returned by snapshots. Treat them as short-lived.

Always re-snapshot after:

- navigation
- form submission
- opening or closing a modal
- expanding dynamic content
- any action that likely changed the DOM

If a ref stops working, assume it is stale and take a new snapshot instead of retrying blindly.

## Actions Reference

### Navigation and page state

```json
{ "action": "open", "url": "https://example.com" }
{ "action": "getUrl" }
{ "action": "getTitle" }
{ "action": "loadUrl", "url": "https://example.com/dashboard" }
{ "action": "wait" }
{ "action": "wait", "predicate": "(() => document.querySelector('.ready') !== null)()", "timeoutMs": 30000 }
```

- `open` accepts an optional `viewport: { width, height }`.
- `loadUrl`, `wait`, and `snapshot` auto-open the session if it does not yet exist and a `url` is provided.
- `wait` defaults to waiting for `document.readyState === 'complete'`. Pass a custom `predicate` for targeted waits. `timeoutMs` defaults to 15000 and caps at 120000.

### Inspection

```json
{ "action": "snapshot" }
{ "action": "snapshot", "maxRefs": 100 }
```

- `snapshot` returns the page URL, title, and a numbered list of interactive elements with refs.
- Each ref line includes the tag, visible text, aria-label, placeholder, and href when available.
- `maxRefs` defaults to 60 and caps at 200. Increase it when a page has many interactive elements.

### Interaction

```json
{ "action": "click", "ref": "@1" }
{ "action": "fill", "ref": "@2", "text": "Jane Doe" }
{ "action": "type", "ref": "@2", "text": "Jane Doe" }
{ "action": "select", "ref": "@3", "value": "Option B" }
{ "action": "check", "ref": "@4", "checked": true }
{ "action": "press", "key": "Enter" }
```

- `fill` replaces the entire value of an input. `type` sends keystrokes one by one.
- `select` uses `value` (preferred) or `text` as the option to choose.
- `check` sets the checked state of a checkbox or radio button.
- `press` sends a key or key combination (e.g. `Enter`, `Tab`, `Control+a`).

### Capture and verification

```json
{ "action": "screenshot", "fileName": "page.png" }
{ "action": "pdf", "fileName": "page.pdf" }
```

- Screenshots and PDFs are saved into the current workspace.
- If `fileName` is omitted, a default name is generated.
- Use screenshots when visual layout matters and snapshots are not enough.

## Session Management

### Default session

If you omit `session`, it defaults to `"default"`. Most simple tasks only need one session.

### Named sessions

Use named sessions whenever you may have multiple independent automations:

```json
{ "action": "open", "session": "site1", "url": "https://site-a.com" }
{ "action": "open", "session": "site2", "url": "https://site-b.com" }
```

This prevents cross-talk between tabs, refs, and state.

### Closing sessions

```json
{ "action": "close" }
{ "action": "close", "session": "site1" }
```

Always close sessions when done. Do not leave background browser windows open unless the task explicitly depends on persistence.

## Authentication and State

Cookies and local storage are shared across all sessions via a single global browser profile. If the user is already logged in from prior browser activity, that state is typically available automatically.

If a task requires logging in and the profile does not already have the necessary cookies:

1. Open the login page.
2. Snapshot to find the username and password field refs.
3. Fill the credentials and submit.
4. Wait for redirect or a post-login indicator.
5. Verify with `getUrl` or `snapshot`.

Do not persist credentials in tool parameters beyond the immediate fill action.

## Debugging Slow or Fragile Pages

Prefer targeted waits instead of arbitrary delays:

```json
{ "action": "wait", "predicate": "(() => document.querySelector('#content') !== null)()" }
{ "action": "wait", "predicate": "(() => window.location.pathname.includes('/dashboard'))()" }
{ "action": "wait", "predicate": "(() => document.body.innerText.includes('Welcome'))()" }
```

If a page is slow, increase `timeoutMs` up to 120000.

## Suggested Working Patterns

### Form fill and submit

```json
{ "action": "open", "url": "https://example.com/form" }
{ "action": "wait" }
{ "action": "snapshot" }
{ "action": "fill", "ref": "@1", "text": "Jane Doe" }
{ "action": "fill", "ref": "@2", "text": "jane@example.com" }
{ "action": "click", "ref": "@3" }
{ "action": "wait" }
{ "action": "snapshot" }
```

### Login and verify redirect

```json
{ "action": "open", "url": "https://app.example.com/login" }
{ "action": "wait" }
{ "action": "snapshot" }
{ "action": "fill", "ref": "@1", "text": "$USERNAME" }
{ "action": "fill", "ref": "@2", "text": "$PASSWORD" }
{ "action": "click", "ref": "@3" }
{ "action": "wait", "predicate": "(() => window.location.pathname.includes('/dashboard'))()" }
{ "action": "getUrl" }
```

### Capture current page state

```json
{ "action": "open", "url": "https://example.com" }
{ "action": "wait" }
{ "action": "screenshot", "fileName": "page.png" }
{ "action": "pdf", "fileName": "page.pdf" }
```

## Cleanup

Close sessions when done:

```json
{ "action": "close" }
{ "action": "close", "session": "site1" }
```

Do not leave background browser windows open unless the task explicitly depends on persistence.
