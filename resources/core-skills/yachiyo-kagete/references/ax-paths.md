# AX Paths — Format, Rules, and Reading Strategy

kagete identifies accessibility elements with **axPath** strings: a slash-separated chain from the window root to the target element, where each segment names an AX role plus (when useful) a disambiguating attribute.

## Segment Grammar

Each path segment has the form:

```
AXRole                          # role alone, when unique among siblings
AXRole[id="value"]              # role + AXIdentifier (preferred when present)
AXRole[title="value"]           # role + AXTitle (fallback)
AXRole[N]                       # role + zero-based sibling index (last resort)
AXRole[id="value"][N]           # combination: indexed siblings sharing an id
```

kagete picks the first of these that disambiguates the element from its siblings:

1. **Identifier** (`AXIdentifier` attribute) — most stable; use when present
2. **Title** (`AXTitle`) — stable as long as the UI string doesn't change
3. **Sibling index** — only when siblings share the same role and neither id nor title differs

Examples from a real TextEdit window:

```
/AXWindow[id="_NS:34"]
/AXWindow[id="_NS:34"]/AXScrollArea[id="_NS:8"]
/AXWindow[id="_NS:34"]/AXScrollArea[id="_NS:8"]/AXTextArea[id="First Text View"]
/AXWindow[id="_NS:34"]/AXButton[0]                    # close button (first of three AXButtons)
/AXWindow[id="_NS:34"]/AXButton[1]                    # minimize
/AXWindow[id="_NS:34"]/AXButton[2]                    # fullscreen
/AXWindow[id="_NS:34"]/AXTabGroup[title="tab bar"]/AXRadioButton[title="kagete-demo.txt"]
```

## Escaping

Inside `[attr="value"]`:

- Backslash `\` → `\\`
- Double quote `"` → `\"`

kagete emits these escapes when building paths, and expects them on input. A title of `say "hi"` renders as `AXTextField[title="say \"hi\""]`.

In shell scripts, prefer **single quotes** around the whole `--ax-path` argument so you don't have to escape the inner `"`:

```bash
kagete press --app Foo --ax-path '/AXWindow/AXButton[title="Save"]'
```

## Stability Rules

Paths are recomputed fresh on every `inspect`/`find` call by walking the AX tree, so:

- **Paths are stable across window redraws, resizes, and theme changes** — the tree structure and role/id/title rarely change.
- **Paths can shift when UI state changes.** A new row inserted above your target pushes its sibling index. An editable title changes the title-based segment. Re-run `find` after any destructive action or after the app's state changes.
- **Identifier segments survive most refactors.** Title segments survive localization changes only if the dev didn't localize that specific string.

## How to Pick a Good Path

When `find` returns several matches, prefer the one with:

1. A single `[id="…"]` segment at the target level — most stable
2. Short path depth — fewer intermediate segments means fewer chances for structure to change
3. Title or id matches that look like real semantic strings, not `"_NS:34"`-style auto-generated IDs (auto IDs _can_ change across app launches)

## Verifying a Path Before Acting

Re-resolve the path first to confirm it still matches:

```bash
kagete find --app Foo --title "Save" --paths-only
# → /AXWindow/AXButton[title="Save"]

# If that path still matches, use the primitive that fits the element's actions:
kagete press --app Foo --ax-path '/AXWindow/AXButton[title="Save"]'        # AXPress-advertising button
# or
kagete action --app Foo --ax-path '…' --name AXShowMenu                    # AXShowMenu-advertising row
# or
kagete set-value --app Foo --ax-path '…/AXTextField' "value"               # writable AXValue
```

If `find` returns zero hits for a path you expected, the tree shifted — re-run `inspect`/`find` and pick a new path.

## Auto-Generated IDs to Watch For

Some Cocoa frameworks emit identifiers like `_NS:34`, `NSTableView1`, or `Button-32`. These are **session-stable but not relaunch-stable** — they change when the app restarts. If your workflow must survive relaunches, prefer title-based paths or role + structural position over auto-IDs.

## Common Root Roles

What you'll typically see as the root segment:

- `AXWindow` — normal app windows
- `AXSheet` — modal sheets attached to a window
- `AXDialog` — free-floating dialogs
- `AXSystemDialog` — system-level alerts

kagete's window selector (`--window "substring"`) matches on window titles regardless of root role.
