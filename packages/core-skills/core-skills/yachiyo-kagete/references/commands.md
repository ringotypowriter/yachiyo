# kagete — Full Command Reference

Every subcommand emits a JSON envelope on stdout — `{ok, command, target?, result?, verify?, hint?, error?}` — unless noted (`--text` / `--paths-only` opt-outs). Errors also emit a short human line on stderr with a non-zero exit code. Target-selector flags (`--app`, `--bundle`, `--pid`, `--window`) are shared across all commands that operate on a specific app — see [../SKILL.md](../SKILL.md) for the selection rules and the full envelope + error-code vocabulary.

---

## `kagete doctor`

Check Accessibility + Screen Recording permissions.

```bash
kagete doctor                # JSON envelope, exit 1 if anything missing
kagete doctor --text         # human-readable report
kagete doctor --prompt       # GUI window to guide the user through granting permissions
```

`--prompt` opens a native macOS window listing each missing permission with its status and an "Open Settings" button that navigates directly to the correct System Settings pane. The window stays open so the user can grant one permission, click "Refresh" to re-check, then grant the next. The detected host process (e.g. Ghostty, not fish or kagete) is shown so the user knows which app to add.

`result` shape: `{accessibility, screenRecording, allGranted}`. When missing grants exist, `hint` names them.

---

## `kagete windows`

Enumerate on-screen windows (`CGWindowList`). Fast, doesn't require AX.

```bash
kagete windows                       # all normal-layer windows
kagete windows --app Safari          # filter by app name
kagete windows --bundle com.apple.TextEdit
kagete windows --pid 12345
```

`result` shape: `{count, windows: [...]}`. Each window record contains: `windowId`, `pid`, `app`, `bundleId`, `title`, `bounds`, `layer`, `onScreen`. `hint` fires when a filter was supplied but `count == 0` (likely minimized / hidden).

---

## `kagete inspect`

**Default: compact summary.** `--tree`: full AX tree dump.

```bash
kagete inspect --app TextEdit                    # summary
kagete inspect --app Safari --window "GitHub" --tree --max-depth 8
kagete inspect --bundle com.apple.finder --tree --full --with-actions
```

Flags:

- `--max-depth N` (default `12`) — cap recursion depth.
- `--tree` — emit the full AX node tree instead of the summary.
- `--full` — with `--tree`: skip pruning of unlabeled `AXUnknown` nodes.
- `--with-actions` — with `--tree`: include each node's AX actions (extra IPC per element, slow on large trees).
- Standard target flags: `--app` / `--bundle` / `--pid` / `--window`.

Default `result` shape (summary):

```json
{
  "window": { "title", "role", "frame" },
  "totalNodes": 847,
  "nodesWithContent": 213,
  "roleHistogram": { "AXButton": 12, "AXTextField": 3, ... },
  "actionableCount": 18,
  "actionableSample": [{ "axPath", "role", "title", "actions": [...] }],
  "focusedAxPath": null
}
```

`hint` nudges you toward `find` (most cases) or `inspect --tree` (large windows, debugging). With `--tree`, `result` is the raw AXNode tree with `children`, same shape as before.

**Prefer `find` over `inspect --tree` when you know what you're looking for.**

---

## `kagete find`

Filtered search over the AX tree.

```bash
kagete find --app TextEdit --role AXButton
kagete find --app Safari --role AXButton --text-contains "Save"
kagete find --app Weather --text-contains "Stockholm, Sweden"
kagete find --app TextEdit --role AXTextArea --paths-only      # plain text, bypass envelope
```

`result` shape: `{count, truncated, limit, disabledCount, hits: [AXHit]}`. Each hit: `role`, `subrole`, `title`, `value`, `description`, `identifier`, `enabled`, `focused`, `actions`, `frame`, `axPath`.

Filters (AND-ed, at least one required):

- `--role AXButton` · `--subrole AXCloseButton`
- `--text-contains "Sav"`: case-insensitive substring matched across title, value, description, help, identifier. One flag, every label. SwiftUI apps put labels in `description`; AppKit in `title`; cells sometimes only in `value`. You don't need to know which; just type what you'd read off the screen.
- `--enabled-only` / `--disabled-only`

Shaping:

- `--limit N` (default `50`). When hits hit the cap, `result.truncated: true` and `hint` tells you how to narrow.
- `--max-depth N` (default `64`).
- `--paths-only` — plain newline-separated `axPath` strings (bypasses envelope, for shell piping).

`hint` branches: no matches → broaden filters; truncated → narrow; single AXPress hit → pass its axPath to `click`; many disabled hits → add `--enabled-only`.

---

## `kagete screenshot`

Capture a PNG of a window via ScreenCaptureKit with an absolute-coordinate grid overlay (red lines every 200 screen points, labeled with click-compatible `x=…`/`y=…` values).

```bash
kagete screenshot --app TextEdit -o /tmp/shot.png
kagete screenshot --bundle com.apple.Safari --window "GitHub" -o gh.png
kagete screenshot --app Foo -o /tmp/clean.png --clean
kagete screenshot --app Foo -o /tmp/s.png --text          # prints only the path
```

Flags:

- `-o, --output PATH` (required) — destination PNG path.
- `--clean` — skip the grid overlay.
- `--grid-pitch N` (default `200`) — grid spacing in screen points.
- `--crop "x,y,w,h"` — window-relative region in screen points; labels still show absolute coords.
- `--text` — print only the output path (shell-friendly) instead of the envelope.
- Standard target flags.

`result` shape: `{path, grid, cropped}`. Errors: `SCK_TIMEOUT` (retryable) when ScreenCaptureKit hangs — wrapper times out at 15 s instead of wedging forever.

---

## `kagete press`

Fire `AXPress` on an element. Pure AX — no cursor movement, no activation, no HID traffic. Works on occluded, offscreen, and hidden-but-loaded windows.

```bash
kagete press --app Safari --ax-path '/AXWindow/AXToolbar/AXButton[title="Reload this page"]'
```

Flags:

- `--ax-path STRING` (required).
- Standard target flags.

`result`: `{axPath, role, title, actions}` — `actions` is what the element advertises, useful to tell an agent which next verb it can reach for.

Errors:

- `AX_ACTION_UNSUPPORTED` — the element doesn't advertise `AXPress`. Check `actions` in the error message (or re-run `find --with-actions`) and pick `action` / `click-at` instead.
- `AX_ACTION_FAILED` — element advertised `AXPress` but the app rejected the call. Agent decision: retry via `click-at` using the element's frame center, or give up.

---

## `kagete action`

Generic AX action dispatcher for actions that aren't `AXPress` or `AXScrollToVisible` (which have their own verbs).

```bash
kagete action --app Finder --ax-path '…/AXRow[3]' --name AXShowMenu         # context menu
kagete action --app System\ Settings --ax-path '…/AXSlider' --name AXIncrement
kagete action --app Mail --ax-path '…/AXCell' --name AXPick
```

Flags:

- `--ax-path STRING` (required).
- `--name` — one of `AXShowMenu`, `AXIncrement`, `AXDecrement`, `AXPick`, `AXConfirm`, `AXCancel` (required).
- Standard target flags.

Errors: same semantics as `press`. `INVALID_ARGUMENT` when `--name` is outside the allowlist — use `press` / `scroll-to` for their respective names.

---

## `kagete focus`

Set `kAXFocusedAttribute = true` on the element. Used before `type --app X` when the target's AX focus isn't already on the right input.

```bash
kagete focus --app Safari --ax-path '/AXWindow/AXToolbar/AXTextField[title="Address"]'
kagete type  --app Safari "https://example.com"
```

Flags:

- `--ax-path STRING` (required).
- Standard target flags.

Errors: `AX_FOCUS_FAILED` when the element rejects the write. Common for DOM-routed web inputs (Safari, Chromium, Electron); fall back to `click-at` on the frame center.

---

## `kagete scroll-to`

Fire `AXScrollToVisible` — semantic "scroll this into view" without synthesizing wheel events or moving the cursor.

```bash
kagete scroll-to --app Xcode --ax-path '…/AXRow[42]/AXCell'
```

Errors: `AX_ACTION_UNSUPPORTED` when the parent scroll area doesn't support the action — use `scroll` with wheel ticks instead.

---

## `kagete click-at`

CGEvent click at `(x, y)`. **No cursor warp** and **no activation** — pure primitive. If the target app isn't frontmost, click may get eaten by click-to-raise on the first call; sequence `activate` first when that matters. If the target control depends on prior pointer motion (hover handlers), sequence `move` first.

```bash
kagete click-at --x 640 --y 480
kagete click-at --x 100 --y 200 --count 2                     # double-click
kagete click-at --x 100 --y 100 --button right
kagete click-at --app Safari --x 640 --y 480                  # --app routes through postToPid
```

Flags:

- `--x DOUBLE` / `--y DOUBLE` (both required).
- `--button left|right|middle` (default `left`).
- `--count N` (default `1`).
- Standard target flags — when provided, events go via `CGEvent.postToPid(pid)` instead of the HID tap, so they don't leak to other apps.

`result` shape: `{button, count, point}`. No implicit `verify` block — follow up with `find` / `screenshot` if you need to confirm the click target.

---

## `kagete move`

Warp the cursor to `(x, y)` and emit the matching `mouseMoved` event. No click.

```bash
kagete move --x 320 --y 240
```

`result` shape: `{point}`.

---

## `kagete activate`

Bring an app to the foreground. Standalone primitive — no other command does this for you.

```bash
kagete activate --app Safari                                  # NSRunningApplication.activate()
kagete activate --app TextEdit --method ax                    # AX frontmost + window raise
kagete activate --app Slack --method both
```

Flags:

- Standard target flags (required — you have to name an app).
- `--method app|ax|both` (default `app`).

`result` shape: `{method, frontmostAfter, changed}`. On success, `frontmostAfter == target app name`. Error `ACTIVATE_FAILED` when the target is still not frontmost after the call — usually means a modal dialog on another app is blocking, or the activation broker is contested (retry with `--method ax`).

---

## `kagete type`

Synthesize Unicode text as keyboard events. **No activate. No auto-focus.** Agent sequences `activate` / `focus` beforehand when needed.

```bash
kagete type --app TextEdit "Hello 🌍 中文"
kagete type --app Notes "Meeting: $(date)"
kagete type "no target — goes to whoever has global focus"
```

Flags:

- `<text>` (positional, required).
- Standard target flags (optional).

`result` shape: `{length}`. `verify` returns the focused element post-type; `hint` fires when no element was focused (text likely went nowhere useful).

Note: `type` appends — it doesn't clear. `kagete key cmd+a` then `kagete key delete` to clear.

**PID-targeted delivery.** When a target is resolved, events are posted with `CGEvent.postToPid(pid)` and reach only that process's responder chain. No target → global HID tap (classic "type into whoever has focus"). Pair with `focus --app X --ax-path …` beforehand if the target app's AX focus isn't already on the intended field.

---

## `kagete set-value`

Write a string straight into an AX element's `kAXValueAttribute` without synthesizing keyboard input. The target app does **not** need to be frontmost, the cursor does not move, and no HID traffic goes through the user's active app — this is the background-capable path for text entry.

```bash
# Fill a Safari address bar while the user keeps working in another window
kagete set-value --app Safari \
    --ax-path '/AXWindow/AXToolbar/AXTextField[title="Address"]' \
    "https://example.com"

# Populate a Mail compose field without stealing focus
kagete set-value --app Mail \
    --ax-path '/AXWindow/AXTextField[title="To:"]' \
    "leader@example.com"
```

Flags:

- `<text>` (positional, required).
- `--ax-path` (required).
- Standard target flags (`--app` / `--bundle` / `--pid`, and optional `--window`).
- `--no-overlay` — skip the awareness pill for this call.
- `--text-output` — print `set-value: wrote N chars to <path> — matched|mismatch` instead of the JSON envelope.

Activation is never performed by this command — `set-value` is a pure AX write. If the target requires its window to be frontmost to accept writes, sequence `kagete activate` beforehand.

`result` shape: `{axPath, role, title, length, valueSet, valueMatches, preValue, postValue}`.

- **`valueMatches`** is the "did it work" signal — `true` iff the post-read value equals the input.
- `valueSet: true` with `valueMatches: false` means the AX write returned `.success` but the app's backing store didn't accept the value verbatim (formatting, validation, needs a commit key). `hint` explains.

Errors:

- `AX_ELEMENT_NOT_FOUND` — `--ax-path` didn't resolve. Re-`find`.
- `AX_NOT_SETTABLE` — the element's `AXValue` is read-only. Common on `AXStaticText`, Electron-hosted inputs, custom NSViews. Use `focus` + `type` or `click-at` + `type` instead.
- `AX_WRITE_FAILED` — write call returned a non-success `AXError`. The field is settable in theory but rejected this particular write (validated field, needs real user interaction).

When to reach for `set-value` vs `type`:

| Situation                                                                  | Prefer                                                                |
| -------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| Standard `AXTextField` / `AXTextArea` / `AXSearchField`                    | `set-value` — no focus theft                                          |
| Custom-drawn input (can't `find`, or `AX_NOT_SETTABLE`)                    | `focus` + `type` (or `click-at` + `type`)                             |
| Field requires a commit event (`return`, blur) to fire downstream handlers | `set-value` + `kagete key return`                                     |
| Web input inside Safari / Chromium / Electron                              | usually `click-at` + `type` (DOM routes focus through the event loop) |

---

## `kagete key`

Send a key combo to the focused element.

```bash
kagete key --app Safari cmd+t             # new tab
kagete key --app TextEdit cmd+s           # save
kagete key --app Foo shift+tab
kagete key --app Bar return
kagete key f12
```

Flags:

- `<combo>` (positional, required) — `cmd+shift+s`, `return`, `f1`..`f12`, arrows, etc.
  - Modifier aliases: `cmd`/`command`/`meta`, `ctrl`/`control`, `opt`/`option`/`alt`, `shift`, `fn`.
  - Named keys: `return`/`enter`, `tab`, `space`, `esc`/`escape`, `delete`/`backspace`, `forward-delete`, `home`, `end`, `pageup`, `pagedown`, `up`/`down`/`left`/`right`, `f1`-`f12`.
- Standard target flags (optional).

`result` shape: `{combo, keyCode}`. `verify.focusedRole/Title` shows where the combo was delivered. Errors: `INVALID_ARGUMENT` for unknown modifiers, multiple base keys, or empty combos.

**No auto-activate.** `key` does not bring the target to the foreground. Menu-bar shortcuts (`cmd+S`, `cmd+Q`, `cmd+W`) typically require the app to be frontmost because macOS dispatches them against the active `NSMenu`; sequence `kagete activate --app X` first for those. Non-menu key events (arrows, text editing, custom shortcuts handled in the responder chain) generally work via `postToPid` without activation.

**PID-targeted delivery.** When a target is resolved, the combo is posted via `CGEvent.postToPid(pid)` so it stays inside the target process. Target-less `kagete key f12` still routes through the HID tap.

---

## `kagete scroll`

Scroll the wheel at the current cursor position.

```bash
kagete scroll --dy -5                      # scroll down 5 lines
kagete scroll --dy 10 --app Safari         # scroll up in Safari
kagete scroll --dx 3 --dy 0 --pixels       # horizontal pixel scroll
```

Flags:

- `--dx INT` (default `0`) — horizontal ticks.
- `--dy INT` (default `0`) — vertical ticks.
- `--pixels` — use pixel units instead of line units.
- Standard target flags (used only for the overlay label; the wheel event still goes through the HID tap at the global cursor position).

`result` shape: `{dx, dy, units}` where `units` is `"lines"` or `"pixels"`.

No auto-activate. Scroll lands at the physical cursor position, so put the cursor where you want it first (`kagete move --x --y`), or sequence `kagete activate` if the target needs to be frontmost before it handles wheel events.

---

## `kagete drag`

Press, move, release. Interpolates intermediate motion so gesture recognizers register it as a real drag.

```bash
kagete drag --app TextEdit --from-x 100 --from-y 130 --to-x 400 --to-y 130
kagete drag --app Finder \
  --from-ax-path '/AXWindow/AXOutline/AXRow[0]' \
  --to-ax-path   '/AXWindow/AXOutline/AXRow[3]'
kagete drag --app Foo --from-x 100 --from-y 200 --to-x 300 --to-y 400 --mod shift
kagete drag --app Finder --from-ax-path '…' --to-ax-path '…' --hold-ms 250
```

Flags:

- `--from-x` / `--from-y` / `--to-x` / `--to-y` — absolute screen points.
- `--from-ax-path` / `--to-ax-path` — AX elements (their frame centers).
- `--steps N` (default `20`) — interpolation steps.
- `--hold-ms MS` (default `0`) — press-and-hold before starting motion.
- `--mod "shift+cmd"` — modifier flags held during drag.
- Standard target flags (required when using `--from-ax-path` / `--to-ax-path`).

`result` shape: `{from, to, steps, holdMs, modifiers}`. `verify.cursor` confirms where the drag released.

No auto-activate. Sequence `kagete activate --app X` first if the target app needs to be frontmost to accept the drag.

---

## `kagete wait`

Poll until a condition holds, with a single structured result. Replaces ad-hoc `for i in …; do kagete find …; sleep 0.25; done` loops: one subprocess, one JSON envelope, one exit code.

```bash
# Wait for any modal button that reads "OK" (up to 5 s)
kagete wait --app TextEdit --role AXButton --text-contains "OK"

# Wait for a specific element's value to land
kagete wait --app Safari --ax-path '…/AXTextField[id="url"]' --value-contains "github.com"

# Wait for a window to open (or close, with --vanish)
kagete wait --window-present --app Finder --window "Downloads"
kagete wait --window-present --app Foo --vanish      # closes

# Plain sleep (no predicate); useful inside chained pipelines
kagete wait --ms 300
```

Modes (exactly one must be specified):

- `--ms N`: fixed sleep, no AX traffic. `--vanish` isn't meaningful here.
- `--ax-path X`: wait for a specific path to resolve. Pair with `--value-contains V` to wait for that element's value to land (great for post-type confirmation).
- Element filters (`--role` / `--subrole` / `--text-contains` / `--enabled-only` / `--disabled-only`): same vocabulary as `kagete find`; any non-empty combination selects element mode. Returns when ≥1 hit (or 0 with `--vanish`).
- `--window-present`: poll `WindowList` for a window matching the target selectors (`--app`/`--bundle`/`--pid` and/or `--window` title substring). With `--vanish`, waits until the window goes away.

Common flags:

- `--vanish`: invert the predicate (wait for it to become false).
- `--timeout MS` (default `5000`): total wait budget.
- `--interval MS` (default `150`): poll interval between probes.
- `--max-depth N` (default `64`): AX recursion cap for element mode.
- `--text`: terse one-liner (`wait element: appeared in 280ms (3 polls)`) instead of the envelope.
- Standard target flags for every non-`--ms` mode.

`result` shape:

```json
{
  "mode": "element",          // "ms" | "path" | "element" | "window"
  "vanish": false,
  "elapsedMs": 280,
  "pollCount": 3,
  "hit":    { … AXHit … },    // element / path modes when appeared
  "window": { … WindowRecord … }  // window mode when appeared
}
```

On timeout the envelope flips to `{ok:false, error:{code:"WAIT_TIMEOUT", retryable:true, message:"wait timed out after … (N polls, mode=…)"}}` and exit code is `1`. `retryable:true` lets agents branch into "widen the filter / bump `--timeout` / screenshot and diagnose" paths instead of treating it as a hard failure.

**Gotcha: query string echoed in the search UI.** `--text-contains` scans every label field. If you just typed your query into a text field, that field's own `value` contains the query, and `wait --text-contains "<query>"` will match the text field on the first poll and return in ~50 ms without waiting for real results. **Always pair the text filter with a `--role` that only exists after the results render** (e.g. `--role AXStaticText`, `--role AXRow`, `--role AXCell`), or use `--ax-path` to target a specific container you expect to populate. Picking a role also prunes the AX walk and keeps polls cheap.

**Gotcha: poll cost dominates short timeouts.** On heavy AX trees (Electron, Chromium-embedded apps) a single `find` traversal can cost 500 ms+, so `--timeout 500 --interval 100` may only fit one probe before the deadline. Either raise `--timeout`, drop `--max-depth`, or narrow the filter so each probe is cheaper.

---

## `kagete raise`

Raise a target window via the AX API — bypasses the activation broker that sometimes contests focus with tools like CleanShot X.

```bash
kagete raise --app TextEdit
kagete raise --bundle com.apple.finder --text
```

Flags:

- Standard target flags.
- `--text` — human-readable report instead of the envelope.

`result` shape: `{setFrontmost, raisedWindow, setMain, frontmostAfter, changedFocus}`. `hint` fires when `changedFocus == false` (another app holding focus).

---

## `kagete release`

Tell the awareness overlay daemon that the agent is done — shows a `✓ control returned` ceremony and retires the overlay.

```bash
kagete release
kagete release "handed back to user"
```

`result` shape: `{label}`. Always succeeds (fire-and-forget to the daemon socket).
