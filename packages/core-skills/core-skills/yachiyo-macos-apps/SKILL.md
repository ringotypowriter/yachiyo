---
name: yachiyo-macos-apps
description: Use this skill to automate Mail, Notes, Reminders, and Calendar on macOS via AppleScript. Create and list emails, notes, reminders, and calendar events using bundled Python wrapper scripts. macOS only.
---

# Yachiyo macOS Apps

Use this skill when the user wants you to interact with the built-in macOS apps Mail, Notes, Reminders, or Calendar through AppleScript.

Read [guide.md](references/guide.md) for detailed AppleScript examples and date-formatting notes.

## Prerequisites

- macOS only (AppleScript requires macOS)
- The target app must be installed (all are pre-installed)
- First use will trigger a macOS TCC Automation permission prompt

## Helper Scripts

All scripts support `--json` for structured output and use `osascript` under the hood.

### Mail

- Compose or send an email

  ```bash
  python3 resources/core-skills/yachiyo-macos-apps/scripts/mail_compose.py --to user@example.com --subject "Hello" --body "Message" --send --json
  ```

- List recent inbox messages
  ```bash
  python3 resources/core-skills/yachiyo-macos-apps/scripts/mail_list.py --mailbox Inbox --count 10 --json
  ```

### Notes

- Create a note

  ```bash
  python3 resources/core-skills/yachiyo-macos-apps/scripts/notes_create.py --title "Ideas" --body "Content here" --folder Notes --json
  ```

- Search notes by title or body
  ```bash
  python3 resources/core-skills/yachiyo-macos-apps/scripts/notes_search.py --query "meeting" --json
  ```

### Reminders

- List reminder lists

  ```bash
  python3 resources/core-skills/yachiyo-macos-apps/scripts/reminders_list_lists.py --json
  ```

- Create a reminder

  ```bash
  python3 resources/core-skills/yachiyo-macos-apps/scripts/reminders_create.py --title "Buy milk" --list "Personal" --due-date "2024-12-25 09:00:00" --json
  ```

- List reminders
  ```bash
  python3 resources/core-skills/yachiyo-macos-apps/scripts/reminders_list.py --list "Personal" --completed false --json
  ```

### Calendar

- List calendars

  ```bash
  python3 resources/core-skills/yachiyo-macos-apps/scripts/calendar_list_calendars.py --json
  ```

- Create an event

  ```bash
  python3 resources/core-skills/yachiyo-macos-apps/scripts/calendar_create_event.py --title "Team Sync" --start-date "2024-12-25 14:00:00" --end-date "2024-12-25 15:00:00" --calendar "Work" --json
  ```

- List events in a date range
  ```bash
  python3 resources/core-skills/yachiyo-macos-apps/scripts/calendar_list_events.py --from-date "2024-12-25 00:00:00" --to-date "2024-12-25 23:59:59" --calendar "Work" --json
  ```

## Good Defaults

- Prefer the helper scripts over inline AppleScript when the task matches a script.
- Use `--json` so you can parse the result reliably.
- When creating calendar events, always provide both `--start-date` and `--end-date` in a format AppleScript can parse (for example, `2024-12-25 14:00:00`).
- Do not send emails unless the user explicitly asks you to; default to opening the compose window (`mail_compose.py` without `--send`).
- Respect Automation permission dialogs — tell the user if a permission error occurs.

## Limitations

- AppleScript cannot read the full content of existing Mail messages in a structured way; listing gives subject and sender only.
- Notes search iterates all notes and can be slow for very large libraries.
- Calendar date comparisons and reminder due dates rely on AppleScript's date parser; locale-specific formats may behave differently.
- Attachments are not supported in the initial mail compose script.

## Verification

Before finishing:

- Confirm the script exited successfully.
- If an object was created (note, reminder, event, or email), state what was created and where.
- If listing data, report the count and any obvious matches.
