#!/usr/bin/env python3
import argparse
import json
import subprocess
import sys


def build_applescript(title, start_date, end_date, calendar=None, location=None, description=None):
    props = [
        'summary:"%s"' % title.replace('"', '\\"'),
        'start date:date "%s"' % start_date.replace('"', '\\"'),
        'end date:date "%s"' % end_date.replace('"', '\\"'),
    ]
    if location:
        props.append('location:"%s"' % location.replace('"', '\\"'))
    if description:
        props.append('description:"%s"' % description.replace('"', '\\"'))
    prop_str = ', '.join(props)

    if calendar:
        return '''tell application "Calendar"
  tell calendar "%s"
    make new event at end with properties {%s}
  end tell
end tell''' % (calendar.replace('"', '\\"'), prop_str)
    else:
        return '''tell application "Calendar"
  make new event with properties {%s}
end tell''' % (prop_str,)


def main():
    parser = argparse.ArgumentParser(description='Create a calendar event in Calendar.app')
    parser.add_argument('--title', required=True)
    parser.add_argument('--start-date', required=True, help='AppleScript-parseable date string')
    parser.add_argument('--end-date', required=True, help='AppleScript-parseable date string')
    parser.add_argument('--calendar', help='Calendar name')
    parser.add_argument('--location')
    parser.add_argument('--description')
    parser.add_argument('--json', action='store_true')
    args = parser.parse_args()

    script = build_applescript(
        args.title, args.start_date, args.end_date, args.calendar, args.location, args.description
    )
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
