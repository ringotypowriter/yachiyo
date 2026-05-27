#!/usr/bin/env python3
import argparse
import json
import subprocess
import sys


def build_applescript(title, list_name=None, due_date=None, notes=None):
    props = ['name:"%s"' % title.replace('"', '\\"')]
    if due_date:
        props.append('due date:date "%s"' % due_date.replace('"', '\\"'))
    if notes:
        props.append('body:"%s"' % notes.replace('"', '\\"'))
    prop_str = ', '.join(props)

    if list_name:
        return '''tell application "Reminders"
  tell list "%s"
    make new reminder at end with properties {%s}
  end tell
end tell''' % (list_name.replace('"', '\\"'), prop_str)
    else:
        return '''tell application "Reminders"
  make new reminder with properties {%s}
end tell''' % (prop_str,)


def main():
    parser = argparse.ArgumentParser(description='Create a reminder in Reminders.app')
    parser.add_argument('--title', required=True)
    parser.add_argument('--list')
    parser.add_argument('--due-date', help='AppleScript-parseable date string, e.g. "2024-12-25 09:00:00"')
    parser.add_argument('--notes')
    parser.add_argument('--json', action='store_true')
    args = parser.parse_args()

    script = build_applescript(args.title, args.list, args.due_date, args.notes)
    try:
        result = subprocess.run(['osascript', '-'], input=script, text=True, capture_output=True, timeout=8)
    except subprocess.TimeoutExpired as exc:
        out = {
            'success': False,
            'stdout': (exc.stdout or '').strip(),
            'stderr': f"{(exc.stderr or '').strip()}\nTimed out waiting for macOS app response.",
        }
        if args.json:
            print(json.dumps(out, indent=2))
        else:
            print(out['stderr'])
        sys.exit(1)
    out = {
        'success': result.returncode == 0,
        'stdout': result.stdout.strip(),
        'stderr': result.stderr.strip(),
    }
    if args.json:
        print(json.dumps(out, indent=2))
    sys.exit(0 if out['success'] else 1)


if __name__ == '__main__':
    main()
