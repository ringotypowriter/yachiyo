# Verify Loop — Closing the Feedback Loop

Blind action is brittle. After every state-changing kagete call, **verify it had the effect you expected** before taking the next step. This is the single biggest reliability lever for GUI automation.

## Two Verification Modes

### 1. Structural — re-query with `find` (or read the command's own envelope)

Fast, machine-readable, works for changes that affect the AX tree (a button appears/disappears, a value updates, a modal opens).

```bash
# Before: save button is enabled
kagete find --app TextEdit --role AXButton --title "Save" | jq '.result.hits[0].enabled'
# true

# Act (menu-bar shortcut — needs frontmost)
kagete activate --app TextEdit
kagete key      --app TextEdit cmd+s

# After: document title lost the "— Edited" suffix (= save succeeded)
kagete find --app TextEdit --role AXWindow --text-contains "Edited" | jq '.result.count'
# 0 — verified
```

Many primitives carry post-action state on the response envelope itself, so you often don't need a follow-up `find`:

| Command                          | Where to read                                                   | What you get                                                                                   |
| -------------------------------- | --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `type` / `key`                   | `verify.focusedRole`, `verify.focusedTitle`, `verify.typeCheck` | Focused element after the keystrokes, plus `typeCheck.textLanded`                              |
| `drag`                           | `verify.cursor`                                                 | Actual cursor point at release                                                                 |
| `set-value`                      | `result.preValue`, `result.postValue`, `result.valueMatches`    | Authoritative "did the write land" signal                                                      |
| `press` / `action` / `scroll-to` | `result.actions`                                                | Advertised actions on the element — confirms you hit the intended target                       |
| `focus`                          | `result.role`, `result.title`                                   | The element that now holds `kAXFocusedAttribute`                                               |
| `activate`                       | `result.frontmostAfter`, `result.changed`                       | Who is actually frontmost now                                                                  |
| `click-at` / `move`              | _nothing implicit_                                              | No verify block — follow up with `find` / `screenshot` / `inspect` to confirm the click target |

```bash
# After type, confirm the keystrokes actually landed in the target field
kagete type --app TextEdit "hello" | jq -e '.verify.typeCheck.textLanded'

# After set-value, confirm the written value survived
kagete set-value --app Safari --ax-path '…' "https://example.com" \
  | jq -e '.result.valueMatches'

# After activate, confirm the target is frontmost
kagete activate --app Safari | jq -e '.result.frontmostAfter == "Safari"'
```

> Note: `click-at` does **not** report a focused role. App-level keyboard focus (`AXFocusedUIElement`) is unrelated to "what was clicked": buttons usually don't take focus, so reading focus after a click would surface whatever sidebar/list happened to hold focus before. To check what a click actually hit, re-`find` or `screenshot`.

### 2. Visual — screenshot and read it

For agents with vision (Claude Code, Claude.ai with image input), a screenshot is a cheap full-state snapshot. Use when the AX tree doesn't expose what you need (canvas renders, custom-drawn UI, visual-only cues like highlight state).

```bash
kagete screenshot --app TextEdit -o /tmp/after.png
# Then Read /tmp/after.png — the agent can see the result directly
```

**Tip for Claude Code:** pass the PNG path to the Read tool. Claude sees the image inline in the conversation.

---

## The Closed-Loop Pattern

```
┌──────────────┐
│  screenshot  │  (baseline, optional)
└──────┬───────┘
       ▼
┌──────────────┐
│     find     │  (get axPath + role + actions)
└──────┬───────┘
       ▼
┌──────────────┐
│   press /    │  (act — verb matches the element's capability)
│   set-value/ │
│   focus+type │
└──────┬───────┘
       ▼
┌──────────────┐
│  read result │  (valueMatches / typeCheck / frontmostAfter / …)
│  or find     │
│  or screen   │
└──────┬───────┘
       ▼
  compare & decide next step
```

---

## Recipe — Screenshot Before/After

```bash
# Baseline
kagete screenshot --app Safari -o /tmp/before.png

# Act
kagete press --app Safari --ax-path '/AXWindow/AXToolbar/AXButton[title="Reload"]'
sleep 1            # app-side network work — not a kagete pacing need

# Capture result
kagete screenshot --app Safari -o /tmp/after.png
```

Then read both images (Claude Code `Read` tool, or whatever your vision layer is) and decide if the outcome matches intent.

---

## Recipe — Structural Diff with `find`

```bash
# Before
before=$(kagete find --app Foo --role AXRow --paths-only | wc -l)

# Act: press a button that should add a row
kagete press --app Foo --ax-path '…'

# After
after=$(kagete find --app Foo --role AXRow --paths-only | wc -l)

if [ "$after" -gt "$before" ]; then
  echo "row added OK"
else
  echo "action did not produce expected row"
fi
```

---

## Recipe — Confirm Focus Landed Before Typing

`focus` waits a short settle window before returning so the target's responder chain has installed. Read `typeCheck` on the follow-up `type`:

```bash
kagete focus --app Mail --ax-path '…/AXTextField[title="To:"]'
result=$(kagete type --app Mail "leader@example.com")

# Authoritative signal: did the text actually land in the field?
echo "$result" | jq -e '.verify.typeCheck.textLanded' >/dev/null || {
  echo "text didn't land — focus may have bounced or the field is DOM-routed"
  exit 1
}
```

For AX-settable fields, `set-value` is a stricter check — `result.valueMatches` is the direct equality test.

---

## Recipe — Wait Until an Expected Element Exists

Useful after actions that open modals or load content. Prefer `kagete wait`:

```bash
# Press something that opens a dialog
kagete press --app Foo --ax-path '…'

# Wait for the dialog's Confirm button to appear (default 5 s timeout)
kagete wait --app Foo --role AXButton --title "Confirm"

# Now safe to interact with the dialog
kagete press --app Foo --ax-path "$(kagete find --app Foo --role AXButton --title Confirm --paths-only)"
```

---

## When to Use Which

| Situation                                                       | Use                                                                              |
| --------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Did my AX action hit the right element?                         | Read `.result.role` / `.result.title` / `.result.actions` on the action envelope |
| Did the value I wrote stick?                                    | `set-value`'s `.result.valueMatches`                                             |
| Did my keystrokes actually type?                                | `type`'s `.verify.typeCheck.textLanded`                                          |
| Did my `activate` bring the app forward?                        | `activate`'s `.result.frontmostAfter`                                            |
| Did a dialog appear?                                            | `find --role AXSheet` / `AXDialog` / `--title "…"` (or `kagete wait`)            |
| Did my click hit the right target?                              | `click-at` has no implicit verify — re-`find` or `screenshot`                    |
| Did the page's visual state change?                             | `screenshot`, then Read                                                          |
| Was a visual-only element (chart, canvas, custom view) updated? | `screenshot`                                                                     |
| Is a long-running op done?                                      | `kagete wait … --vanish` on a "loading" indicator                                |

---

## Common Verification Mistakes

- **Verifying too late.** Verify between every action, not at the end of a 10-step chain — when something breaks you want to know which step failed.
- **Only screenshotting.** Screenshots are expensive (ScreenCaptureKit capture + PNG encode). Prefer structural signals when a primitive already carries them.
- **Trusting exit codes alone.** `kagete type`/`key`/`click-at` return `ok:true` whenever the event was _posted_, not when it was _received_. The app may have swallowed it. Always check the envelope's post-action signal (`typeCheck.textLanded`, `valueMatches`, or a follow-up `find`).
- **Not re-finding paths.** An axPath you used 5 seconds ago may no longer resolve. Re-`find` before each new act.
- **Wrong verb for the element.** `press` an `AXStaticText` returns `AX_ACTION_UNSUPPORTED`. Read the hit's `actions` list before picking the verb — the error is telling you which primitive to switch to.
