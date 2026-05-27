---
name: yachiyo-macos-screenshot
description: Capture screenshots on macOS via AppleScript. Use when the user wants you to take a screenshot of their screen, a specific window, or a selected area. Supports saving to a file or copying to the clipboard. macOS only.
---

# Yachiyo macOS Screenshot

Use this skill when the user wants you to capture their macOS screen via AppleScript.

## Prerequisites

- macOS only (AppleScript and `screencapture` require macOS)
- First use may trigger a macOS Screen Recording permission prompt

## Helper Script

The bundled `screenshot.py` script wraps `osascript` and `screencapture` under the hood.

### Full screen

```bash
python3 resources/core-skills/yachiyo-macos-screenshot/scripts/screenshot.py --mode fullscreen --output /path/to/screenshot.png --json
```

### Interactive window selection

```bash
python3 resources/core-skills/yachiyo-macos-screenshot/scripts/screenshot.py --mode window --output /path/to/window.png --json
```

### Interactive area selection

```bash
python3 resources/core-skills/yachiyo-macos-screenshot/scripts/screenshot.py --mode area --output /path/to/area.png --json
```

### Copy to clipboard instead of saving

```bash
python3 resources/core-skills/yachiyo-macos-screenshot/scripts/screenshot.py --mode fullscreen --clipboard --json
```

### Include cursor

```bash
python3 resources/core-skills/yachiyo-macos-screenshot/scripts/screenshot.py --mode fullscreen --cursor --output /path/to/screenshot.png --json
```

## Good Defaults

- Always use `--json` so you can parse the result reliably.
- If the user does not specify an output path and does not ask for clipboard, the script writes to a temp file and returns the path in JSON.
- When the user says "screenshot my screen" or "look at my screen," default to `--mode fullscreen`.
- When the user says "screenshot this window," use `--mode window`.
- Warn the user if a Screen Recording permission dialog appears and the script fails.

## Verification

Before finishing:

- Confirm the script exited successfully (`success: true` in JSON).
- If saved to a file, confirm the output path exists.
- If copied to clipboard, state that the image is on the clipboard.
