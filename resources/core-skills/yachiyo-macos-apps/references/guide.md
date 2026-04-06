# Yachiyo macOS Apps — Guide

This guide covers AppleScript interactions with Mail, Notes, Reminders, and Calendar on macOS.

## Date Formats

AppleScript understands most locale-aware date strings. The safest cross-locale format is:

```
2024-12-25 14:00:00
```

If you get a date-parsing error, try the short date string for your region or use `current date` in AppleScript for "now".

## Mail

### Send a simple email

```bash
osascript -e '
tell application "Mail"
  set newMessage to make new outgoing message with properties {subject:"Hello", content:"Body text"}
  make new to recipient at end of to recipients of newMessage with properties {address:"to@example.com"}
  send newMessage
end tell'
```

### List unread messages

```bash
osascript -e '
tell application "Mail"
  set out to ""
  repeat with m in messages of inbox whose read status is false
    set out to out & (subject of m) & tab & (sender of m) & linefeed
  end repeat
  return out
end tell'
```

## Notes

### Create a note in a specific folder

```bash
osascript -e '
tell application "Notes"
  tell account "iCloud"
    make new note at folder "Notes" with properties {name:"Title", body:"Body"}
  end tell
end tell'
```

### Get a note's body by name

```bash
osascript -e '
tell application "Notes"
  set n to first note whose name is "Title"
  return body of n
end tell'
```

## Reminders

### Complete a reminder by name

```bash
osascript -e '
tell application "Reminders"
  tell list "Personal"
    set r to first reminder whose name is "Buy milk"
    set completed of r to true
  end tell
end tell'
```

### Delete a reminder

```bash
osascript -e '
tell application "Reminders"
  tell list "Personal"
    delete (first reminder whose name is "Buy milk")
  end tell
end tell'
```

## Calendar

### Delete an event

```bash
osascript -e '
tell application "Calendar"
  tell calendar "Work"
    delete (first event whose summary is "Old Meeting")
  end tell
end tell'
```

### Open Calendar to a specific date

Calendar does not expose a reliable `show date` AppleScript command. If you need UI navigation, use GUI scripting via System Events or ask the user to open Calendar manually.
