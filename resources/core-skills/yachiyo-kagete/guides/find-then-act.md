# Find-Then-Act — The Canonical Pipeline

Every kagete-driven task boils down to: discover an `axPath` with `find`, then act on it with a **primitive that matches the element's advertised capability**. kagete primitives never fall back silently — you read `find`'s `actions` list (and/or `role`) and pick the correct verb yourself.

## The Mental Model

```
kagete find …  ──▶  axPath + actions + role  ──▶  one of:
                                                  kagete press         (element advertises AXPress)
                                                  kagete action        (AXShowMenu / AXIncrement / …)
                                                  kagete set-value     (writable AXValue, e.g. text fields)
                                                  kagete focus + type  (fields without settable AXValue)
                                                  kagete scroll-to     (element advertises AXScrollToVisible)
                                                  kagete click-at      (pure coord click; works anywhere)
                                                  kagete drag          (coords or AX paths; cursor motion)
```

Always **re-find** after anything that changes app state (a `press`, navigation, modal open/close). Paths are stable under redraws but not under structural changes.

When a primitive doesn't fit (e.g. the element is a custom-drawn view with no AX advertisements), fall through to the Visual path: `screenshot` to get coords, then `click-at` / `drag`.

---

## Recipe 1 — Press a Button by Title

```bash
# 1. Locate
kagete find --app Safari --role AXButton --text-contains "Reload" --paths-only
# → /AXWindow/AXToolbar/AXButton[title="Reload this page"]

# 2. Act — AXPress, no cursor movement, no activation
kagete press --app Safari \
  --ax-path '/AXWindow/AXToolbar/AXButton[title="Reload this page"]'
```

### One-liner (fish shell)

```fish
set p (kagete find --app Safari --role AXButton --text-contains "Reload" --paths-only | head -1)
and kagete press --app Safari --ax-path $p
```

### One-liner (bash / zsh)

```bash
p=$(kagete find --app Safari --role AXButton --text-contains "Reload" --paths-only | head -1)
[ -n "$p" ] && kagete press --app Safari --ax-path "$p"
```

### When `press` returns `AX_ACTION_UNSUPPORTED`

The element doesn't advertise `AXPress`. The error message lists what it does advertise. Pick the right next verb:

- `AXShowMenu` → `kagete action --name AXShowMenu`
- `AXIncrement` / `AXDecrement` → `kagete action --name AXIncrement`
- Nothing useful → get the element's frame from `find`, then `kagete click-at --x <center-x> --y <center-y>`

---

## Recipe 2 — Type into a Field

Two clean paths. Try (a) first; fall back to (b) when the element returns `AX_NOT_SETTABLE`.

### (a) Background AX write — `set-value`

```bash
kagete find --app Mail --role AXTextField --text-contains "To" --paths-only
# → /AXWindow/AXSplitGroup/…/AXTextField[title="To:"]

kagete set-value --app Mail \
  --ax-path '/AXWindow/…/AXTextField[title="To:"]' \
  "leader@example.com"
```

No focus theft, no cursor movement. If `result.valueMatches` is `true`, you're done.

### (b) Keyboard synthesis — `focus` + `type`

Use this when `set-value` returns `AX_NOT_SETTABLE` (Electron, web, custom NSViews), or when the field needs real key events to trigger downstream handlers.

```bash
kagete focus --app Mail --ax-path '/AXWindow/…/AXTextField[title="To:"]'
kagete type  --app Mail "leader@example.com"
```

`kagete focus` installs `kAXFocusedAttribute = true` and then waits a short settle window so `type` can deliver keystrokes to a fully-installed first responder. When a target is resolved, `type` routes through `CGEvent.postToPid(pid)` — events reach only that process, not the user's frontmost app.

**Clearing before writing.** `kagete type` appends. To replace:

```bash
# Either re-write via set-value (preferred)
kagete set-value --app Mail --ax-path '…' "new value"

# Or clear via keyboard
kagete focus --app Mail --ax-path '…'
kagete key   --app Mail cmd+a
kagete key   --app Mail delete
kagete type  --app Mail "new value"
```

---

## Recipe 3 — Select Text via Drag

```bash
# Get the text area's frame
kagete find --app TextEdit --role AXTextArea
# → frame: { x: 120, y: 118, width: 2303, height: 1200 }

# Drag across a known region (line 1 of the document)
kagete drag --app TextEdit \
  --from-x 130 --from-y 132 \
  --to-x 500 --to-y 132

# Or: select-all via keyboard (safer for unknown layouts)
kagete activate --app TextEdit          # key commands through the menu bar need frontmost
kagete key      --app TextEdit cmd+a
```

---

## Recipe 4 — Open a Menu, Pick an Item

Menu-bar shortcuts route through macOS's `NSMenu` dispatcher, which requires the target app to be frontmost:

```bash
# File → Save As…
kagete activate --app TextEdit
kagete key      --app TextEdit cmd+shift+s
```

Context menus on an element — use the semantic verb:

```bash
kagete action --app Finder \
  --ax-path '/AXWindow/AXOutline/AXRow[3]' \
  --name AXShowMenu
```

Traversing the menu bar as AX elements:

```bash
kagete find  --app Safari --role AXMenuItem --title "Develop" --paths-only
kagete press --app Safari --ax-path '…'                        # opens the menu
kagete find  --app Safari --role AXMenuItem --title "Show Web Inspector" --paths-only
kagete press --app Safari --ax-path '…'
```

---

## Recipe 5 — Wait for an Element to Appear

Prefer `kagete wait` — one subprocess, structured result, clean timeout:

```bash
# Wait for "Continue" button (up to 5 s default), then press it
path=$(kagete wait --app Foo --role AXButton --title "Continue" --paths-only)
[ -n "$path" ] && kagete press --app Foo --ax-path "$path"

# Or: wait for a loading spinner to vanish
kagete wait --app Foo --role AXStaticText --text-contains "Loading" --vanish
```

Manual polling is only worth it when `wait`'s mode doesn't fit:

```bash
for i in {1..20}; do
  path=$(kagete find --app Foo --title "Continue" --paths-only 2>/dev/null | head -1)
  [ -n "$path" ] && kagete press --app Foo --ax-path "$path" && break
  sleep 0.25
done
```

---

## Recipe 6 — Walk a List / Table

```bash
# Get all rows in a Finder outline
kagete find --app Finder --role AXRow --paths-only
# /AXWindow/AXOutline/AXRow[0]
# /AXWindow/AXOutline/AXRow[1]
# /AXWindow/AXOutline/AXRow[2]
# …

# Single-activate the third one (opens the file in Finder if the row advertises AXPress)
kagete press --app Finder --ax-path '/AXWindow/AXOutline/AXRow[2]'

# Double-click style open — use click-at at the row's frame center
ROW='/AXWindow/AXOutline/AXRow[2]'
BOUNDS=$(kagete find --app Finder --role AXRow --paths-only=false \
  | jq --arg p "$ROW" '.result.hits[] | select(.axPath == $p) | .frame')
cx=$(jq -r '(.x + .width/2)'  <<<"$BOUNDS")
cy=$(jq -r '(.y + .height/2)' <<<"$BOUNDS")
kagete activate --app Finder
kagete click-at --app Finder --x "$cx" --y "$cy" --count 2
```

---

## Anti-Patterns

| Don't                                                | Because                                                                                                                                                                                                                   |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `kagete inspect --tree` then `jq`/`grep` everything  | Use `find` with filters — it's the targeted query. Default `inspect` returns a compact summary, not the firehose                                                                                                          |
| Hardcode pixel coordinates                           | They break on resize, DPI change, theme switch. Re-read the element's `frame` before each use                                                                                                                             |
| Cache an axPath across state-changing actions        | Re-`find` after every `press`/navigation/modal                                                                                                                                                                            |
| Split a pipeline across multiple bash tool calls     | Chain with `&&` in **one** invocation — lower latency, cleaner failure semantics                                                                                                                                          |
| Skip sleep between steps that trigger UI transitions | Menus, modals, network responses need a render cycle. Use `kagete wait` when a predicate fits; `sleep 0.2`–`0.5` otherwise                                                                                                |
| Batch multiple apps in one kagete invocation         | One target per command; chain with `&&` within the same app                                                                                                                                                               |
| Pick a primitive without reading `actions` first     | If the element doesn't advertise `AXPress`, `press` returns `AX_ACTION_UNSUPPORTED`. Read the hit's `actions` in `find` output and pick the matching verb (`action --name …`, `set-value`, `focus + type`, or `click-at`) |

---

## Failure Modes & Quick Fixes

| Symptom                          | Likely cause                                                                          | Fix                                                                                                                     |
| -------------------------------- | ------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `Error: No AX windows for pid N` | App closed or hid its windows                                                         | Reopen the app, confirm with `kagete windows`                                                                           |
| `Error: No window matching "X"`  | Title substring wrong                                                                 | Run `kagete windows --app Foo` to see actual titles                                                                     |
| `AX_ELEMENT_NOT_FOUND`           | Tree shifted since you got the path                                                   | Re-run `find`, pick a fresh path                                                                                        |
| `AX_ACTION_UNSUPPORTED`          | `press`/`action`/`scroll-to` target doesn't advertise the action                      | Read the error's "advertised actions" list and use the matching verb, or fall back to `click-at` on the frame center    |
| `AX_NOT_SETTABLE`                | `set-value` on a read-only field (custom NSView, DOM input)                           | Use `focus` + `type` instead                                                                                            |
| `AX_FOCUS_FAILED`                | `focus` rejected (web/DOM input)                                                      | `click-at` the frame center to install focus, then `type`                                                               |
| `ACTIVATE_FAILED`                | Target still not frontmost (modal on another app, or token broker contested)          | Retry `activate --method ax` or `--method both`                                                                         |
| `PERMISSION_DENIED`              | System privacy gate                                                                   | `kagete doctor --prompt`, then user approves **the host process** (terminal / harness, _not_ kagete) in System Settings |
| Keystrokes vanish                | Target app isn't frontmost _and_ command relies on global focus (e.g. menu shortcuts) | Sequence `kagete activate --app X` before the input command                                                             |
