#!/usr/bin/env python3
import argparse
import json
import subprocess
import sys


def build_applescript(title, body, account=None, folder=None):
    title_escaped = title.replace('"', '\\"')
    body_escaped = body.replace('"', '\\"')
    if account and folder:
        return '''tell application "Notes"
  tell account "%s"
    make new note at folder "%s" with properties {name:"%s", body:"%s"}
  end tell
end tell''' % (
            account.replace('"', '\\"'),
            folder.replace('"', '\\"'),
            title_escaped,
            body_escaped,
        )
    elif folder:
        return '''tell application "Notes"
  make new note at folder "%s" with properties {name:"%s", body:"%s"}
end tell''' % (
            folder.replace('"', '\\"'),
            title_escaped,
            body_escaped,
        )
    else:
        return '''tell application "Notes"
  make new note with properties {name:"%s", body:"%s"}
end tell''' % (
            title_escaped,
            body_escaped,
        )


def main():
    parser = argparse.ArgumentParser(description='Create a note in Notes.app')
    parser.add_argument('--title', required=True)
    parser.add_argument('--body', required=True)
    parser.add_argument('--account')
    parser.add_argument('--folder', default='Notes')
    parser.add_argument('--json', action='store_true')
    args = parser.parse_args()

    script = build_applescript(args.title, args.body, args.account, args.folder)
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
