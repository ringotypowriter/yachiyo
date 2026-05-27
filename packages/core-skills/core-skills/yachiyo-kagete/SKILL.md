---
name: kagete
description: Use this skill when you need to inspect, click, type, drag, scroll, or screenshot native macOS app windows — Safari, Finder, TextEdit, Xcode, Slack desktop, System Settings, or any other native macOS application. Triggers include requests like "click the Save button in X", "automate Finder", "read the AX tree of Y", "screenshot Xcode window", "type into TextEdit", "drag to reorder in Z", and any GUI task outside a browser.
allowed-tools: Bash(kagete:*), Bash(curl:*)
---

# kagete — macOS computer-use CLI

kagete gives agents **eyes and hands** for any macOS application through the Accessibility API and ScreenCaptureKit:

- **Eyes:** `inspect` (full AX tree) · `find` (filtered query) · `screenshot` (PNG) · `windows` (enumerate)
- **Hands:** `click` · `type` · `key` · `scroll` · `drag`

Every command emits a uniform JSON envelope on stdout — `{ok, command, target, result, verify, hint, error}` — so agents branch on `ok` + `error.code` instead of parsing per-command shapes. See [Output Envelope](#output-envelope) below.

## Install

If `command -v kagete` returns nothing, run the one-liner (requires macOS 14+, Apple Silicon):

```bash
curl -fsSL https://raw.githubusercontent.com/ringotypowriter/kagete/main/install.sh | bash
```

Installs to `~/.local/bin/kagete`. The installer follows a GitHub redirect (no API token needed) and verifies SHA256 before install. After install, if `~/.local/bin` isn't on PATH, the installer prints the exact shell-rc line to add.

## Preflight — ALWAYS RUN FIRST

**Before the first `kagete` call in every session, run `kagete doctor`.** No exceptions. Without the right permissions, `click`/`type`/`key`/`drag` will _silently drop all input events_ — commands return `ok:true`, nothing happens in the UI, the agent loops confused. One preflight check up-front saves the session.

```bash
kagete doctor
```

If Accessibility or Screen Recording is missing, surface the exact `hint` from the envelope to the user. **Critical gotcha:** macOS grants these permissions **per-process to the binary that owns the process tree** — which is _not_ `kagete`. It's whatever launched it: **Terminal / iTerm2 / Ghostty / Warp / Claude Code / Codex / your agent harness**. The `doctor` output names the detected host process and the System Settings path; relay that verbatim — don't paraphrase, and don't ever tell the user to "add kagete to Accessibility" (that won't work).

`kagete doctor --prompt` triggers the macOS system dialogs for any missing grants, but the user still has to tick the checkbox for the host process in System Settings → Privacy & Security.

## Two paths: AX and Visual

Different apps expose themselves to automation in very different ways. Pick the path that fits the target — switching is cheap.

### 1. AX path — the default, for well-behaved AppKit/SwiftUI apps

Safari, Finder, TextEdit, Xcode, System Settings, Notes, Mail, Slack desktop, most native SwiftUI/AppKit apps.

```
┌───────────┐    ┌───────────┐    ┌───────┐    ┌────────┐
│   FIND    │ →  │  LOCATE   │ →  │  ACT  │ →  │ VERIFY │
│  find     │    │ stable    │    │ click │    │ refind │
│  inspect  │    │ axPath    │    │ type  │    │ or     │
│           │    │           │    │ drag  │    │ screen │
└───────────┘    └───────────┘    └───────┘    └────────┘
```

- Queries: `kagete find --role AXButton --text-contains "Save"`
- Actions: `kagete press --ax-path '…'` — semantic `AXPress`, works on occluded or scrolled-off targets with no cursor movement. Use `kagete action --name AXShowMenu|AXIncrement|…` for the other AX actions, `kagete set-value` for text, `kagete focus` before `kagete type` when a field needs AX focus installed.
- Stability: `axPath` survives resizes, redraws, theme changes
- Prefer this path when `find` returns what you're looking for with coords

### 2. Visual path — for custom-drawn / AX-hostile apps

Custom-drawn apps, Electron apps with optimized-away trees, games, canvas-based UIs, embedded webviews that hide text from AX. **Diagnostic: `find --text-contains <visible text>` returns `[]` for text clearly on screen → flip to Visual.**

```
┌──────────────┐    ┌──────────┐    ┌──────────────┐    ┌────────────────┐
│  SCREENSHOT  │ →  │   READ   │ →  │  CLICK x,y   │ →  │   VERIFY       │
│  grid + crop │    │ coords   │    │ (with --x=   │    │  screenshot →  │
│  for zoom-in │    │ off grid │    │  for negs)   │    │  cursor cross  │
└──────────────┘    └──────────┘    └──────────────┘    └────────────────┘
```

- `kagete screenshot -o /tmp/s.png` — overlays a coordinate grid (200-pt pitch). Labels match `click --x --y` directly.
- `kagete screenshot --crop "x,y,w,h"` — zoom into a window-relative region. Labels still show absolute screen coords.
- After each click, the next screenshot renders a **pink crosshair** at the cursor's actual landing position plus a corner `cursor: (x, y)` badge. Use this to self-correct when you misread row positions.
- Negative x or y needs the `=` syntax: `--x=-1700 --y=1500`.

### Mental model

| App type                           | Signal                                    | Path                                                          |
| ---------------------------------- | ----------------------------------------- | ------------------------------------------------------------- |
| AX-indexed element with AXPress    | `find` returns it, `actions: ["AXPress"]` | AX + `--ax-path`                                              |
| AX-indexed but custom-drawn        | `find` returns it, `actions: null`        | AX to locate frame center, then `click --x --y` at the center |
| No AX at all                       | `find` empty for visible text             | Visual — screenshot grid + coords                             |
| Mixed (toolbar AX but body custom) | Search box indexed, result rows not       | AX for the input, Visual for results                          |

**Never act without locating first.** Whether the handle is an `axPath`, an AX frame center, or a coord read off the grid — always locate before you click.

## Target Selection

Every command that operates on an app accepts these flags:

| Flag                        | Use when                                                             |
| --------------------------- | -------------------------------------------------------------------- |
| `--app "Safari"`            | Well-known app; matches localized name or executable                 |
| `--bundle com.apple.Safari` | Most stable; prefer when scripting long-lived workflows              |
| `--pid 12345`               | Last resort — PIDs change on every relaunch                          |
| `--window "GitHub"`         | Narrow when an app has multiple windows (case-insensitive substring) |

If `--app` matches multiple running apps, kagete errors with a numbered list — narrow with `--bundle` or `--pid`.

## Commands at a Glance

**Primitives only.** Every command does exactly one thing in one way — no hidden fallback, no auto-activate, no auto-focus. You compose them based on the `actions` list in `find` output and the error codes returned. If something is missing (e.g. a button doesn't advertise AXPress), you see that in the data and pick the next primitive yourself.

| Command             | Purpose                                                                                    | Layer        |
| ------------------- | ------------------------------------------------------------------------------------------ | ------------ |
| `kagete doctor`     | Check permissions                                                                          | Setup        |
| `kagete windows`    | List on-screen windows                                                                     | Read         |
| `kagete inspect`    | Full AX tree of one window                                                                 | Read         |
| `kagete find`       | Filtered element search — includes `actions` per hit                                       | Read         |
| `kagete screenshot` | Window → PNG with coordinate grid + cursor crosshair                                       | Read         |
| `kagete press`      | Fire `AXPress` on an element                                                               | AX semantic  |
| `kagete action`     | Fire a named AX action (AXShowMenu, AXIncrement, AXDecrement, AXPick, AXConfirm, AXCancel) | AX semantic  |
| `kagete focus`      | Set `kAXFocusedAttribute = true` on an element                                             | AX semantic  |
| `kagete set-value`  | Write `kAXValueAttribute` on an element (background text input)                            | AX semantic  |
| `kagete scroll-to`  | Fire `AXScrollToVisible` on an element                                                     | AX semantic  |
| `kagete raise`      | AX-level window raise                                                                      | App control  |
| `kagete activate`   | Bring app to foreground (`--method app\|ax\|both`)                                         | App control  |
| `kagete click-at`   | CGEvent click at (x, y) — no warp, no activate                                             | HID          |
| `kagete move`       | Warp the cursor to (x, y)                                                                  | HID          |
| `kagete type`       | Synthesize Unicode text — PID-targeted when a target is resolved                           | HID          |
| `kagete key`        | Single key combo — PID-targeted when a target is resolved                                  | HID          |
| `kagete scroll`     | Wheel ticks at current cursor position                                                     | HID          |
| `kagete drag`       | Press → move → release (coords or AX paths)                                                | HID          |
| `kagete wait`       | Poll for element / window / value, or fixed sleep                                          | Control flow |
| `kagete release`    | Retire the awareness overlay                                                               | Overlay      |

## Deep Dives

- [references/commands.md](references/commands.md) — every subcommand with all flags and realistic examples
- [references/ax-paths.md](references/ax-paths.md) — how `axPath` strings are built, sibling indexing, escaping rules
- [references/troubleshooting.md](references/troubleshooting.md) — AX-vs-Visual diagnosis, input-drop from event-tap interference (CleanShot, Zoom), activation fallback via `KAGETE_RAISE=ax`
- [guides/find-then-act.md](guides/find-then-act.md) — the canonical shell pipeline: locate → act in one flow
- [guides/pipelines.md](guides/pipelines.md) — ready-to-run multi-step recipes: search-and-select, fill a form, replace-text, visual-path end-to-end, wait-for-modal, scroll-to-find, right-click menu
- [guides/verify-loop.md](guides/verify-loop.md) — closed-loop verification with screenshots and re-queries

## Output Envelope

Every command writes a single JSON object to stdout:

```json
{
  "ok": true,
  "command": "click",
  "target":  { "pid": 1234, "app": "Safari", "bundle": "com.apple.Safari", "window": "GitHub" },
  "result":  { "method": "ax-press", "button": "left", "count": 1, "point": {...}, "element": {...} },
  "verify":  { "cursor": {...} },
  "hint":    "optional machine-readable next-step"
}
```

On failure the shape flips to `{ok:false, command, target?, error:{code, message, retryable, hint?}}` and exit code is non-zero. A short human line also goes to stderr.

**Branch on `ok` + `error.code` — never string-match `.message`.**

`ErrorCode` vocabulary (stable contract):

| Code                    | When                                                                  | Retryable                                                                                         |
| ----------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `PERMISSION_DENIED`     | Accessibility or Screen Recording not granted                         | no                                                                                                |
| `INVALID_ARGUMENT`      | Bad flags or values (`--button foo`, empty `--crop`, missing filters) | no                                                                                                |
| `TARGET_NOT_FOUND`      | `--app/--bundle/--pid` didn't match any running app                   | no                                                                                                |
| `AMBIGUOUS_TARGET`      | `--app "Claude"` matched multiple apps                                | no — narrow with `--bundle`/`--pid`                                                               |
| `AX_ELEMENT_NOT_FOUND`  | `--ax-path` didn't resolve in the current tree                        | no — re-`find`                                                                                    |
| `AX_NO_FRAME`           | Element located but frame is empty/hidden                             | no                                                                                                |
| `AX_NOT_SETTABLE`       | `set-value` target does not expose a writable `AXValue`               | no — use `focus` + `type`                                                                         |
| `AX_WRITE_FAILED`       | `set-value` write call returned non-success from AX                   | no — input likely rejected by the app                                                             |
| `AX_ACTION_UNSUPPORTED` | `press` / `action` / `scroll-to` target doesn't advertise the action  | no — inspect `result.actions` in `find` output and pick a supported verb                          |
| `AX_ACTION_FAILED`      | Element advertised the action but AX call returned non-success        | no — usually means the app intercepted the call                                                   |
| `AX_FOCUS_FAILED`       | `focus` target rejected `kAXFocusedAttribute`                         | no — web/DOM inputs route focus through the event loop; use `click-at` on the element frame first |
| `ACTIVATE_FAILED`       | `activate` didn't make the target frontmost                           | no — retry with a different `--method`, or check for a modal dialog on another app                |
| `SCK_TIMEOUT`           | ScreenCaptureKit hung past the 15 s guard                             | **yes**                                                                                           |
| `WAIT_TIMEOUT`          | `kagete wait` hit `--timeout` before the condition held               | **yes** — widen the filter, raise `--timeout`, or screenshot to diagnose                          |
| `INTERNAL`              | Genuine runtime/invariant failure                                     | no                                                                                                |

Key fields to know:

- **`result`** — command-specific success payload (see [references/commands.md](references/commands.md))
- **`verify`** — post-action state snapshot. For `type`/`key`, `verify.focusedRole` + `focusedTitle` tell you which element received the input, without a follow-up `inspect`/`screenshot`. For `click`/`drag`, `verify.cursor` shows the actual cursor position after input — use it to confirm the click landed at the requested point. (Click verify intentionally omits `focusedRole`: app focus is unrelated to "what was clicked" — re-`find` or `screenshot` if you need to verify the click target itself.)
- **`hint`** — machine-readable next-step when kagete can infer one (e.g. `"Hit --limit (50) — narrow with --enabled-only"`). Absent when none applies.

Every action command accepts `--text` (or equivalent, documented per command) to emit a terse one-liner instead of the envelope — handy for humans running commands interactively. `kagete find --paths-only` stays as plain newline-separated axPath strings for shell piping.

## Key Principles

1. **Try AX first, flip to Visual on evidence.** Start with `find`. If `result.count == 0` for text you can see on screen, the app is custom-drawn — switch to screenshot + coords without hesitation.
2. **Prefer `find` over `inspect --tree`.** Most windows have 1000+ AX nodes. `inspect` (default) returns a compact summary; use it only for survey. `find --role AXButton --text-contains "Save"` is the targeted query.
3. **`axPath` beats coordinates when both exist.** Paths are stable across redraws; coords break on first resize.
4. **Read `verify` before re-screenshotting.** For `type`/`key` it gives you the focused element post-action; for `drag` it gives the actual cursor coord. For AX semantic verbs (`press`, `action`, `focus`, `set-value`) the `result` already carries the post-action element state (role, title, `valueMatches`, advertised `actions`). Only screenshot to confirm when result/verify is insufficient — e.g. something visual-only, or when the downstream UI shape matters.
5. **Activation is NOT automatic.** Input commands (`type`, `key`, `click-at`, `drag`, `scroll`) no longer activate the target app — you call `kagete activate --app X` yourself when the target needs to be frontmost (typical for NSMenu shortcuts and coord-based clicks on backgrounded windows). AX semantic verbs (`press`, `action`, `focus`, `set-value`, `scroll-to`) never need activation; they write/read the AX layer directly on whatever process you name.
   - **PID-targeted HID.** `type` and `key` route through `CGEvent.postToPid(pid)` whenever a target is resolved — events enter the target process's responder chain, not the global HID tap, so they do **not** leak to the user's frontmost app. Without a target, they fall back to the HID tap.
   - **Text input without focus theft.** Prefer `set-value` when the element accepts a writable `AXValue`. When `set-value` returns `AX_NOT_SETTABLE` (Electron/web inputs, custom NSViews), call `focus` + `type --app X` instead.
   - **Clicks on backgrounded apps.** Coord-based `click-at` lands as a "phantom click" — the target sees the click without preceding mouse motion. Most controls accept this. If the target needs real motion (hover handlers) sequence `move` then `click-at`. If the target refuses clicks while not frontmost, sequence `activate` first.
6. **Sleep between semantic steps, not inside them.** kagete paces low-level events (mouse-down → mouse-up, inter-keystroke) internally — don't wrap those. But between distinct high-level steps (click → menu renders, type → network request returns, `key cmd+s` → save dialog appears), pause before the next kagete call reads its post-action state. Prefer **`kagete wait`** over blind `sleep` when the transition has a detectable signal (modal button appears, value lands, window opens, spinner vanishes with `--vanish`) — it exits as soon as the condition holds and structurally reports timeout. Use bare `sleep` only when no predicate fits: `sleep 0.2` after a menu opens, `sleep 0.3–0.5` after a short view swap.
7. **Chain sequential steps in one bash/exec call.** A pipeline of `kagete press && sleep 0.2 && kagete key && …` should live in **one** shell invocation, not split across multiple tool calls. Each tool-call boundary costs latency and context; chaining with `&&` keeps the sequence atomic (a failing step aborts the rest) and couples each action with its post-step sleep in one place. Reserve separate tool calls for branching on the **result** of a previous pipeline — not for stepping through a fixed sequence.
8. **One target per command.** Chain sub-steps of a single-app flow; don't try to batch multiple apps inside one `kagete` invocation.
9. **Error-code branching, not message parsing.** `jq -e '.ok'` to gate; `jq -r '.error.code'` to route. Messages are for humans; codes are for you.
