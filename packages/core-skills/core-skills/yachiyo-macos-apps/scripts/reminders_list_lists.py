#!/usr/bin/env python3
import argparse
import json
import subprocess
import sys


def build_applescript():
    return '''tell application "Reminders"
  set out to ""
  repeat with l in lists
    set out to out & (name of l) & linefeed
  end repeat
  return out
end tell'''


def main():
    parser = argparse.ArgumentParser(description='List reminder lists in Reminders.app')
    parser.add_argument('--json', action='store_true')
    args = parser.parse_args()

    script = build_applescript()
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
        out['lists'] = [line.strip() for line in result.stdout.strip().splitlines() if line.strip()]
        print(json.dumps(out, indent=2))
    sys.exit(0 if out['success'] else 1)


if __name__ == '__main__':
    main()
