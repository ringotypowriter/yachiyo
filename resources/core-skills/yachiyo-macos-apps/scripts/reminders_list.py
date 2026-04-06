#!/usr/bin/env python3
import argparse
import json
import subprocess
import sys


def build_applescript(list_name=None, show_completed=None):
    filter_clause = ''
    if show_completed is True:
        filter_clause = ' whose completed is true'
    elif show_completed is False:
        filter_clause = ' whose completed is false'

    if list_name:
        return '''tell application "Reminders"
  set out to ""
  repeat with r in reminders of list "%s"%s
    set out to out & (name of r) & tab & (completed of r) & tab & (due date of r) & tab & (id of r) & linefeed
  end repeat
  return out
end tell''' % (list_name.replace('"', '\\"'), filter_clause)
    else:
        return '''tell application "Reminders"
  set out to ""
  repeat with r in reminders%s
    set out to out & (name of r) & tab & (completed of r) & tab & (due date of r) & tab & (id of r) & linefeed
  end repeat
  return out
end tell''' % (filter_clause,)


def main():
    parser = argparse.ArgumentParser(description='List reminders from Reminders.app')
    parser.add_argument('--list', help='List name')
    parser.add_argument('--completed', choices=['true', 'false', 'all'], default='all')
    parser.add_argument('--json', action='store_true')
    args = parser.parse_args()

    completed = None
    if args.completed == 'true':
        completed = True
    elif args.completed == 'false':
        completed = False

    script = build_applescript(args.list, completed)
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
        items = []
        for line in result.stdout.strip().splitlines():
            parts = line.split('\t')
            if len(parts) >= 4:
                items.append({
                    'name': parts[0],
                    'completed': parts[1] == 'true',
                    'due_date': parts[2] if parts[2] != 'missing value' else None,
                    'id': parts[3],
                })
        out['reminders'] = items
        print(json.dumps(out, indent=2))
    sys.exit(0 if out['success'] else 1)


if __name__ == '__main__':
    main()
