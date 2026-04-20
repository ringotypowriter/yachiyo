# Pipeline Patterns — Ready-to-Run Sequences

Common multi-step workflows an agent can follow verbatim and adapt. Each pipeline is designed to be **copy-friendly** — the agent can swap app names and query strings without rethinking the shape.

Read [find-then-act.md](find-then-act.md) first for the primitives; this file composes them.

## Execution discipline (read first)

Three rules apply to every pipeline below:

1. **Run the entire pipeline in one bash/exec tool call.** The blocks below are shown with one step per line for readability — when you actually run them, chain the steps with `&&` (or keep the `for` loops inline) inside a single tool invocation. Separate tool calls add latency and context overhead; a single `&&`-chained call also aborts cleanly on the first failing step.
2. **Sleep between high-level steps, not inside them.** kagete paces micro-events inside each command. But after a step that triggers a UI transition (menu opens, modal appears, network request returns), add a short sleep before the next `find` / `screenshot` / action so you read the new state, not the old one. Rules of thumb: `0.2 s` after a context menu or submenu opens, `0.3–0.5 s` after a modal or view swap, `sleep 0.25` inside poll loops for network-bound waits. Without sleep, `find` can return the pre-transition tree and you act on stale paths.
3. **Pick the primitive that matches the element's advertised capability.** Read `find`'s `actions` list. `AXPress` → `kagete press`. `AXShowMenu` / `AXIncrement` / … → `kagete action --name …`. Writable `AXValue` (text field) → `kagete set-value`. Non-settable text input → `kagete focus` + `kagete type`. No useful AX advertisement → `kagete click-at` at the element's frame center.

Every pipeline here follows all three rules.

---

## Pipeline 1 — Search in a List, Open the First Result

The canonical "open app → search for X → act on the result" flow. Works for Finder (find in folder), Mail (search mailbox), Spotify, iTunes/Music, Photos, any search-box-plus-results app.

```bash
APP="Mail"

# 1. Locate the search box
SEARCH=$(kagete find --app "$APP" --role AXTextField --text-contains "Search" --paths-only | head -1)

# 2. Write the query via AX (no focus theft, no keystrokes), then commit with return
kagete set-value --app "$APP" --ax-path "$SEARCH" "invoice 2026"
kagete activate  --app "$APP"                         # return key needs frontmost for most search UIs
kagete key       --app "$APP" return

# 3. Wait for results to populate, then open the first row
kagete wait --app "$APP" --role AXRow --timeout 3000 >/dev/null
HIT=$(kagete find --app "$APP" --role AXRow --paths-only | head -1)

# 4. Open it. Rows that advertise AXPress fire on single activation;
#    otherwise, double-click at the frame center.
if kagete find --app "$APP" --role AXRow --limit 1 \
     | jq -e '.result.hits[0].actions | index("AXPress")' >/dev/null; then
  kagete press --app "$APP" --ax-path "$HIT"
else
  BOUNDS=$(kagete find --app "$APP" --role AXRow --limit 1 | jq '.result.hits[0].frame')
  cx=$(jq -r '(.x + .width/2)'  <<<"$BOUNDS")
  cy=$(jq -r '(.y + .height/2)' <<<"$BOUNDS")
  kagete click-at --app "$APP" --x "$cx" --y "$cy" --count 2
fi
```

**Variant — visual-path when the results are custom-drawn:**

```bash
# After the search commits, screenshot the results pane
kagete screenshot --app "$APP" -o /tmp/r.png --crop "250,150,800,400" --grid-pitch 100

# Read the first row's approximate center off the grid labels, then
kagete click-at --app "$APP" --x 450 --y 340 --count 2

# The next screenshot shows a pink crosshair at the landing spot.
# If it's above or below the target row, adjust y by the row height and retry.
kagete screenshot --app "$APP" -o /tmp/r-after.png --crop "250,150,800,400"
```

---

## Pipeline 2 — Fill a Multi-Field Form

Login windows, preference panes, new-record dialogs.

```bash
APP="Notes"

# Each field: try set-value first; fall back to focus+type for DOM/Electron inputs
fill_field() {
  local path="$1" value="$2"
  if ! kagete set-value --app "$APP" --ax-path "$path" "$value" >/dev/null 2>&1; then
    kagete focus --app "$APP" --ax-path "$path"
    kagete type  --app "$APP" "$value"
  fi
}

NAME=$(kagete find --app "$APP" --role AXTextField --text-contains "Name"  --paths-only | head -1)
MAIL=$(kagete find --app "$APP" --role AXTextField --text-contains "Email" --paths-only | head -1)
PASS=$(kagete find --app "$APP" --role AXSecureTextField                       --paths-only | head -1)

fill_field "$NAME" "Leader"
fill_field "$MAIL" "leader@example.com"
fill_field "$PASS" "********"

# Submit
kagete activate --app "$APP"            # return is a menu-bar-ish commit; safer frontmost
kagete key      --app "$APP" return
```

**Why `set-value` first:** zero keystrokes, zero focus theft, one round-trip per field. Fall back to `focus`+`type` only when `set-value` can't (DOM inputs, Electron text — those return `AX_NOT_SETTABLE`).

---

## Pipeline 3 — Replace Text in a Field

`set-value` overwrites by definition — one call does the whole thing:

```bash
FIELD=$(kagete find --app Safari --role AXTextField --id "UnifiedAddress" --paths-only | head -1)

kagete set-value --app Safari --ax-path "$FIELD" "https://github.com"
kagete activate  --app Safari
kagete key       --app Safari return
```

If the field returns `AX_NOT_SETTABLE`, fall back to the keyboard path:

```bash
kagete focus --app Safari --ax-path "$FIELD"
kagete key   --app Safari cmd+a
kagete key   --app Safari delete
kagete type  --app Safari "https://github.com"
kagete key   --app Safari return
```

---

## Pipeline 4 — Visual Path End-to-End (Custom-Drawn App)

When `find` returns `[]` for text you can clearly see, the app is rendering without exposing the AX tree. Switch to coordinates off the grid overlay.

```bash
APP="SomeCustomApp"

# 1. Bring the app forward (coord clicks on backgrounded windows get eaten by click-to-raise)
kagete activate --app "$APP"

# 2. If the search bar IS AX-indexed, use it; otherwise snapshot and pick coords
SEARCH=$(kagete find --app "$APP" --text-contains "Search" --paths-only | head -1)
if [ -n "$SEARCH" ]; then
  kagete set-value --app "$APP" --ax-path "$SEARCH" "Jane Doe" \
    || { kagete focus --app "$APP" --ax-path "$SEARCH"; kagete type --app "$APP" "Jane Doe"; }
else
  kagete screenshot --app "$APP" -o /tmp/s1.png      # full window, default grid
  # Read the grid label under the visible search bar, then:
  kagete click-at --app "$APP" --x 694 --y 95
  kagete type     --app "$APP" "Jane Doe"
fi
kagete key --app "$APP" return
sleep 2     # wait for results render

# 3. Screenshot a tight crop of the results area, read a row's coords
kagete screenshot --app "$APP" -o /tmp/s2.png --crop "250,200,800,500" --grid-pitch 100

# 4. Click the row; next screenshot confirms the crosshair landed on it
kagete click-at --app "$APP" --x 450 --y 340 --count 2
kagete screenshot --app "$APP" -o /tmp/s3.png --crop "250,200,800,500"
```

**Self-correct loop:** If the post-click screenshot's pink crosshair is above the intended row, add roughly one row-height (~40–60 points) to y and re-click. The corner badge shows the exact cursor coord.

---

## Pipeline 5 — Menu Item via Shortcut, with AX Fallback

Menu-bar shortcuts dispatch through the active app's `NSMenu`, so the app must be frontmost:

```bash
APP="TextEdit"

# Happy path — keyboard shortcut
kagete activate --app "$APP"
kagete key      --app "$APP" cmd+shift+s

# Fallback — no shortcut / shortcut unknown: walk AXMenuBar
MENU=$(kagete find --app "$APP" --role AXMenuBarItem --title "File" --paths-only | head -1)
kagete press --app "$APP" --ax-path "$MENU"
sleep 0.2

ITEM=$(kagete find --app "$APP" --role AXMenuItem --title "Duplicate" --paths-only | head -1)
kagete press --app "$APP" --ax-path "$ITEM"
```

---

## Pipeline 6 — Wait for a Modal, Dismiss It

Common after destructive or network actions. `kagete wait` replaces the old bash poll loop — single subprocess, structured timeout, one exit code to branch on.

```bash
APP="Foo"

# Trigger the action, wait for the modal button, press it.
kagete activate --app "$APP" && \
kagete key      --app "$APP" cmd+shift+delete && \
kagete wait     --app "$APP" --role AXButton --title "OK" --timeout 6000 && \
OK_PATH=$(kagete find --app "$APP" --role AXButton --title "OK" --paths-only | head -1) && \
kagete press    --app "$APP" --ax-path "$OK_PATH"
```

If the modal might never appear (network dropped, action no-oped), branch on the wait's exit code instead of chaining with `&&`:

```bash
if kagete wait --app "$APP" --role AXButton --title "OK" --timeout 6000 >/dev/null; then
  OK_PATH=$(kagete find --app "$APP" --role AXButton --title "OK" --paths-only | head -1)
  kagete press --app "$APP" --ax-path "$OK_PATH"
else
  # WAIT_TIMEOUT — surface to the user, diagnose with a screenshot.
  kagete screenshot --app "$APP" -o /tmp/no-modal.png
fi
```

`kagete wait --vanish …` is the symmetric tool for "wait until the spinner / progress bar / toast is gone before the next step" — same shape, inverted predicate.

---

## Pipeline 7 — Scroll Until an Element Becomes Visible

AX can see offscreen elements by frame, but clicks only land on what the window is actually rendering. Two clean paths:

### (a) Semantic — when the scroll area advertises `AXScrollToVisible`

```bash
APP="Xcode"

TARGET=$(kagete find --app "$APP" --text-contains "quarterly-report" --paths-only | head -1)

# One call, no wheel events, no cursor motion
if kagete scroll-to --app "$APP" --ax-path "$TARGET" 2>/dev/null; then
  kagete press --app "$APP" --ax-path "$TARGET"
fi
```

### (b) Wheel-based — when `AX_ACTION_UNSUPPORTED` on (a)

```bash
APP="Finder"

kagete activate --app "$APP"                          # scroll lands at cursor, app must be frontmost
for i in {1..20}; do
  HIT=$(kagete find --app "$APP" --text-contains "quarterly-report" --paths-only 2>/dev/null | head -1)
  if [ -n "$HIT" ]; then
    ON_SCREEN=$(kagete find --app "$APP" --text-contains "quarterly-report" --enabled-only 2>/dev/null \
                | jq -r '.result.hits[0].frame | (.y > 0 and .y < 1200)')
    if [ "$ON_SCREEN" = "true" ]; then
      kagete press --app "$APP" --ax-path "$HIT"
      break
    fi
  fi
  kagete scroll --app "$APP" --dy -5                  # scroll down at current cursor
  sleep 0.2
done
```

---

## Pipeline 8 — Context Menu, Pick an Item

Prefer the semantic verb — `AXShowMenu` opens a context menu without cursor movement and without synthesizing a right-click:

```bash
APP="Finder"

ROW=$(kagete find --app "$APP" --role AXRow --text-contains "Report.pdf" --paths-only | head -1)

# Open the context menu via AX
kagete action --app "$APP" --ax-path "$ROW" --name AXShowMenu
sleep 0.2

# Pick an item by title (menus expose AXMenuItem)
ITEM=$(kagete find --app "$APP" --role AXMenuItem --title "Get Info" --paths-only | head -1)
kagete press --app "$APP" --ax-path "$ITEM"
```

If `AXShowMenu` returns `AX_ACTION_UNSUPPORTED`, fall back to a right-click at the row's frame center:

```bash
BOUNDS=$(kagete find --app "$APP" --role AXRow --text-contains "Report.pdf" | jq '.result.hits[0].frame')
cx=$(jq -r '(.x + .width/2)'  <<<"$BOUNDS")
cy=$(jq -r '(.y + .height/2)' <<<"$BOUNDS")
kagete activate --app "$APP"
kagete click-at --app "$APP" --x "$cx" --y "$cy" --button right
```

---

## Adapting These

Each pipeline is a template. To adapt:

1. Swap `APP`, filter strings, and target titles.
2. If a `find` comes back empty, shorten `--text-contains`, drop `--role`, or widen the query before falling back to Visual.
3. Check the element's advertised `actions` before picking a verb — `find … --limit 1 | jq '.result.hits[0].actions'` is the fastest probe.
4. Bump the `sleep` count for slow apps (first-run, cold cache, network fetches).
5. Always end with a structured verify (`result.valueMatches`, `verify.typeCheck.textLanded`, a follow-up `find`, or a `screenshot`) — trust but confirm.
