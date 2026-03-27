# Yachiyo Browser Guide

## Purpose

Use `yachiyo-browser` for practical browser work with the `agent-browser` CLI:

- open and inspect websites
- click, type, select, and submit forms
- capture screenshots or PDFs
- extract visible content
- verify UI flows and page changes
- work with authenticated sessions when needed

## Definition Of Done

- The requested page or flow was actually exercised.
- The final state was verified with a fresh snapshot, URL check, text check, screenshot, diff, or download check.
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

```bash
agent-browser open https://example.com
agent-browser wait --load networkidle
agent-browser snapshot -i
```

If the snapshot shows refs like `@e1` and `@e2`, use them directly:

```bash
agent-browser fill @e1 "user@example.com"
agent-browser click @e2
agent-browser wait --load networkidle
agent-browser snapshot -i
```

## Command Strategy

Use separate commands when you need to inspect output between steps. That is the normal case for:

- discovering refs from `snapshot -i`
- checking text or URL after an action
- debugging slow or dynamic pages

Chain with `&&` only when every step is already known and no intermediate output needs to be read.

Safe example:

```bash
agent-browser open https://example.com && agent-browser wait --load networkidle && agent-browser screenshot page.png
```

## Element Refs

Refs like `@e1` are session-local handles returned by snapshots. Treat them as short-lived.

Always re-snapshot after:

- navigation
- form submission
- opening or closing a modal
- expanding dynamic content
- any action that likely changed the DOM

If a ref stops working, assume it is stale and take a new snapshot instead of retrying blindly.

## Commands To Reach For First

### Navigation and page state

```bash
agent-browser open <url>
agent-browser get url
agent-browser get title
agent-browser wait --load networkidle
agent-browser wait --url "**/dashboard"
agent-browser wait --text "Welcome"
```

### Inspection

```bash
agent-browser snapshot -i
agent-browser snapshot -i --json
agent-browser get text @e1
agent-browser get text body
```

### Interaction

```bash
agent-browser click @e1
agent-browser fill @e2 "text"
agent-browser type @e2 "text"
agent-browser select @e3 "Option"
agent-browser check @e4
agent-browser press Enter
```

### Capture and verification

```bash
agent-browser screenshot
agent-browser screenshot --full
agent-browser screenshot --annotate
agent-browser pdf output.pdf
agent-browser diff snapshot
agent-browser diff screenshot --baseline before.png
```

## Authentication And State

Choose the lightest persistence model that fits the task.

### One-off reuse from an existing browser

Use this when the user is already logged in and you only need to borrow that state:

```bash
agent-browser --auto-connect state save ./auth.json
agent-browser --state ./auth.json open https://app.example.com/dashboard
```

### Persistent profile

Use this for recurring manual or semi-automated work:

```bash
agent-browser --profile ~/.myapp open https://app.example.com/login
```

### Session name

Use this when you want cookies and local storage to come back automatically:

```bash
agent-browser --session-name myapp open https://app.example.com/login
agent-browser close
```

### Manual state files

Use this when the task needs an explicit artifact:

```bash
agent-browser state save ./auth.json
agent-browser state load ./auth.json
```

Rules:

- State files may contain sensitive tokens. Do not commit them.
- Only persist auth if the task needs it.
- If auth is temporary, clean it up before finishing.

## Session Isolation

Use named sessions whenever you may have multiple independent automations.

```bash
agent-browser --session site1 open https://site-a.com
agent-browser --session site2 open https://site-b.com
agent-browser session list
```

This prevents cross-talk between tabs, refs, and state.

## Visual And Responsive Checks

Use screenshots when layout matters and snapshots are not enough.

```bash
agent-browser set viewport 1440 900
agent-browser screenshot desktop.png

agent-browser set viewport 390 844
agent-browser screenshot mobile.png
```

Use `screenshot --annotate` when you need spatial reasoning or unlabeled controls. It gives you a picture plus ref labels in one step.

## Downloads And Files

Use explicit output paths when a task expects a file:

```bash
agent-browser download @e1 ./file.pdf
agent-browser wait --download ./output.zip
agent-browser --download-path ./downloads open https://example.com
```

Verify that the expected file exists before reporting success.

## Debugging Slow Or Fragile Pages

Prefer targeted waits instead of arbitrary delays:

```bash
agent-browser wait --load networkidle
agent-browser wait "#content"
agent-browser wait --url "**/complete"
agent-browser wait --fn "document.readyState === 'complete'"
```

If commands suddenly time out, check for blocking dialogs:

```bash
agent-browser dialog status
agent-browser dialog accept
agent-browser dialog dismiss
```

## Reliable Extraction

For data extraction, confirm the exact scope first.

```bash
agent-browser snapshot -i
agent-browser get text @e5
agent-browser get text body
```

Use JSON mode when another tool or script needs structured output:

```bash
agent-browser snapshot -i --json
agent-browser get text @e1 --json
```

## Suggested Working Patterns

### Form fill and submit

```bash
agent-browser open https://example.com/form
agent-browser wait --load networkidle
agent-browser snapshot -i
agent-browser fill @e1 "Jane Doe"
agent-browser fill @e2 "jane@example.com"
agent-browser click @e3
agent-browser wait --load networkidle
agent-browser snapshot -i
```

### Login and verify redirect

```bash
agent-browser open https://app.example.com/login
agent-browser wait --load networkidle
agent-browser snapshot -i
agent-browser fill @e1 "$USERNAME"
agent-browser fill @e2 "$PASSWORD"
agent-browser click @e3
agent-browser wait --url "**/dashboard"
agent-browser get url
```

### Capture current page state

```bash
agent-browser open https://example.com
agent-browser wait --load networkidle
agent-browser screenshot --full page.png
agent-browser pdf page.pdf
```

## Cleanup

Close sessions when done:

```bash
agent-browser close
agent-browser --session site1 close
agent-browser close --all
```

Do not leave background browser processes running unless the task explicitly depends on persistence.
