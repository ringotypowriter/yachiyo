# Yachiyo Browser Guide

## Purpose

Use `yachiyo-browser` for practical browser work with the `useBrowser` tool:

- open and inspect websites
- click, type, select, and submit forms
- capture screenshots or PDFs
- extract visible content via snapshots
- verify UI flows and page changes
- work with authenticated sessions when needed

The browser is an embedded Electron page that the user can see and interact with directly. If you hit a blocking step the user can handle (e.g. CAPTCHA, login, 2FA, consent dialog), ask the user to perform it rather than failing. Sessions are scoped to the current conversation, but cookies and local storage are shared via a single global browser profile.

## Definition Of Done

- The requested page or flow was actually exercised.
- The final state was verified with the latest action observation, URL check, screenshot, or PDF (a fresh snapshot when necessary).
- Any output artifact exists where expected.
- The session was closed unless the task explicitly needed it left open.

## Core Loop

`open`, `loadUrl`, navigation and interaction actions return a compact observation containing URL,
page text and current refs. Read it before making another call. Do not automatically chain
`open → wait → snapshot` or `click → wait → snapshot`. Use a conditional `wait` only when a
specific application condition is not met, then `snapshot` to inspect it. Use `snapshot` with
`query` or `scopeRef` when the compact observation omits needed detail.

Refs identify actual DOM elements, not XPath positions. They are generation-specific and
may become stale after a new snapshot, navigation or element removal. Pass the ref exactly as
shown without `@` and never retry a mutation blindly after an observation failure: the action
may already have completed. A failed attached snapshot is reported separately from the action.

```json
{ "action": "open", "url": "https://example.com" }
{ "action": "fill", "ref": "<fresh-ref-from-open>", "text": "Jane Doe" }
{ "action": "snapshot", "query": "Continue" }
{ "action": "snapshot", "scopeRef": "<fresh-container-ref>" }
```

Snapshot refs include accessible labels, roles and control state; password values are not
returned. Snapshot text explicitly signals truncation. Open shadow roots and same-origin
frames can be inspected; cross-origin frames may be inaccessible and are reported as such.

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

- `snapshot` returns URL, title, viewport text and interactive elements with refs. `query` searches text and control attributes; `scopeRef` limits observation to descendants of a fresh ref.
- Each ref can include label, role, value (except passwords), checked, disabled, expanded, placeholder, and href.
- `maxRefs` defaults to 60 and caps at 200. Increase it when a page has many interactive elements.

### Interaction

```json
{ "action": "click", "ref": "e1" }
{ "action": "fill", "ref": "e2", "text": "Jane Doe" }
{ "action": "type", "ref": "e2", "text": "Jane Doe" }
{ "action": "select", "ref": "e3", "value": "Option B" }
{ "action": "check", "ref": "e4", "checked": true }
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

New windows and `target="_blank"` links become browser tabs. Read the session handles in the
observation and pass the intended `session` on subsequent calls; do not guess tab names.

### User control

The browser panel provides **Take over** and **Resume**. Taking over blocks new and queued
agent writes, including arbitrary `eval` and JavaScript waits. Do not create a replacement
session to bypass this boundary. Wait for the user to resume, then inspect fresh state.
Already dispatched site requests cannot be undone by taking over.

Pending JavaScript dialogs are shown in the panel. A snapshot can report the pending dialog
without executing page code; the user must accept or dismiss it before automation resumes.

### Closing sessions

```json
{ "action": "close" }
{ "action": "close", "session": "site1" }
```

Close temporary sessions when done. Do not close a page the user asked to retain.

## Authentication and State

Cookies and local storage are shared across all sessions via a single global browser profile. If the user is already logged in from prior browser activity, that state is typically available automatically.

If a task requires logging in and the profile does not already have the necessary cookies:

1. Open the login page.
2. Use refs from the open result (or take a local snapshot if needed).
3. Fill the credentials and submit.
4. Inspect the attached action observation; wait for a post-login indicator only if needed.
5. Verify with `getUrl` or `snapshot`.

Do not persist credentials in tool parameters beyond the immediate fill action.

## Eval results

`eval` executes an async JavaScript function body. Explicitly `return` the value or Promise you want back; a bare expression returns `undefined`.

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

Open the page and identify fields in the attached observation. Fill one field, inspect
its action observation for fresh refs, and continue. Submit with a current ref. Verify
that the resulting page actually shows the desired outcome. If fields are omitted,
request a local `snapshot` with `query` or `scopeRef` instead of a fixed delay.

### Login and verify redirect

Ask the user to complete CAPTCHA or two-factor steps. Use current field refs and avoid
printing credentials in snapshots or reports. After submit, inspect the action observation.
If redirect has not happened yet, use `wait` with a targeted URL or element predicate,
then inspect the final URL or take a fresh snapshot.

### Capture current page state

```json
{ "action": "open", "url": "https://example.com" }
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
