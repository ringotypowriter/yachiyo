# Troubleshooting — When Input Seems to Drop

Symptoms and fixes for the non-obvious failure modes. Most kagete problems are either permission drift or event-tap interference from other running tools.

## Input silently drops or scrambles

Target app is visibly frontmost, `activate()` succeeded, but `type` lands partial characters (`HeUn` instead of `Hello`), or `click` hits the wrong element, or keystrokes arrive out of order.

**Likely cause:** another process has installed a **session-level CGEventTap** on the same input stream. Confirmed offenders:

- **CleanShot X** — "Record clicks" / "Record keyboard" visualization during screen recording
- **Zoom** — annotation & remote-control modes
- **Karabiner-Elements** with heavy complex modifications
- **Some remote-desktop clients** (Anydesk, Teamviewer) when the session is active

Our events post at `.cghidEventTap` (below session), so any session tap sees them before the target app does. A slow or filtering tap callback stalls or mutates the stream.

**Fix — ask the user to toggle the visualization off** while the agent is driving:

- CleanShot X → Preferences → Recording → uncheck "Show clicks" and "Show keyboard"
- Zoom → stop annotation tools before automation
- Karabiner → temporarily disable rules

## Target app won't come to front

`kagete activate --app X` returns `ACTIVATE_FAILED`, or your menu-bar shortcut (`cmd+S` via `kagete key`) has no effect. Common causes:

- Another tool holds activation (CleanShot recording toolbar, QuickTime recorder)
- The CLI is launched from a non-frontmost shell and the macOS 14+ activation-token broker rejects `NSRunningApplication.activate()`

`kagete activate` exposes three methods; agent picks based on what you're fighting:

| `--method`      | Path                                                           | Use when                                                                                    |
| --------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `app` (default) | `NSRunningApplication.activate()`                              | Standard activation, window-unaware (pass no `--window`)                                    |
| `ax`            | `AXFrontmost` attribute + `AXRaiseAction` on a specific window | The activation broker is contested, _or_ you need to raise a specific window via `--window` |
| `both`          | AX raise first, then `app.activate()`                          | Belt-and-suspenders for flaky apps                                                          |

```bash
# Standalone AX-only raise — no window-server notification
kagete raise --app TextEdit

# Default — whole-app activation, no window filter
kagete activate --app TextEdit

# Window-specific — must use ax/both because `app` is window-unaware
kagete activate --app Safari --window "GitHub" --method ax
```

Note: `kagete activate --method app` rejects `--window` with `INVALID_ARGUMENT` — `NSRunningApplication.activate()` has no notion of specific windows, so silently ignoring the filter would be wrong.

## Permission errors appear mid-run

```
Error: Accessibility permission not granted.
```

**Critical gotcha: the permission is not granted to `kagete` itself.** macOS grants Accessibility and Screen Recording _per-process_, and the effective grant belongs to the binary that owns the process tree — i.e., whatever launched kagete. That's **Terminal / iTerm2 / Ghostty / Warp / Claude Code / Codex / the agent harness**, not `kagete`.

Adding `kagete` to the Accessibility list in System Settings **does nothing**. The checkbox has to be for the host process.

**Fix:**

```bash
kagete doctor --prompt
```

The text output of `kagete doctor` names the detected host process and the exact System Settings path. Relay that verbatim to the user — don't substitute "kagete" for it. After the user toggles the right app on, re-run `kagete doctor` to confirm.

macOS also revokes Accessibility when a binary is moved, replaced, or re-signed — if your terminal / harness was updated recently, its checkbox may have silently flipped off. A toggle-off / toggle-on usually refreshes the grant.

## `find` returns nothing but the element is visible

Two different root causes:

**A. Timing / filter too strict.** The window may not have finished building its AX tree (lazy-loaded views, SwiftUI first render), or the filter keyed on a too-specific attribute.

Fixes, in order:

1. Shorten `--text-contains` or drop `--role`. `--text-contains` already scans title, value, description, help, identifier; if it still misses, the substring itself is probably off.
2. Re-run once after a short delay (up to ~500 ms for SwiftUI cold renders).
3. Fall back to `inspect --max-depth 8` to see the actual tree and pick a sibling-indexed path.

**B. Custom-drawn UI: go visual.** Some apps render entire surfaces with custom drawing and never publish the visible text through AX. Common patterns: custom-rendered list views, Electron apps with aggressive tree-shaking, game launchers, canvas-based UIs. Diagnostic: `find --text-contains <visible text> --limit 5` returns `[]` for text you can clearly see on screen.

When this happens, switch to the visual path:

```bash
# Grid-annotated screenshot — labels show absolute screen coords every
# 200 points, matching what `click-at --x --y` uses directly.
kagete screenshot --app "QQ音乐" -o /tmp/view.png

# Read /tmp/view.png, pick the coord off the grid, click.
# (Activate first — coord clicks on a backgrounded window can be eaten by click-to-raise.)
kagete activate --app "QQ音乐"
kagete click-at --app "QQ音乐" --x 496 --y 375 --count 2
```

`screenshot` captures at a sensible default for agent consumption (~1 MB PNG for a typical window). Pass `--clean` to drop the grid overlay, `--grid-pitch 100` for denser labeling when targeting small UI.

> Use **negative-coord syntax** — arg parser needs `--x=-1200` with the `=`, not `--x -1200`.

## `drag` doesn't trigger the drop target

Some apps require a **hold before drag** to distinguish click from drag (Finder columns, iOS-simulator gestures). Use `--hold-ms`:

```bash
kagete drag --app Finder --from-x 200 --from-y 300 --to-x 600 --to-y 300 --hold-ms 200
```

Also: not every element accepts synthesized drag. Canvas-based apps (web canvases, some games) may ignore it entirely — fall back to `click` + modifier keys or shortcut-based selection.
