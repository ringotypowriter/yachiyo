#!/usr/bin/env python3
import argparse
import json
import subprocess
import sys


def build_applescript(mailbox='Inbox', count=10):
    return '''tell application "Mail"
  set out to ""
  set msgList to messages of mailbox "%s"
  if (count of msgList) > %d then set msgList to items 1 thru %d of msgList
  repeat with m in msgList
    set out to out & (subject of m) & tab & (sender of m) & tab & (date received of m) & linefeed
  end repeat
  return out
end tell''' % (mailbox.replace('"', '\\"'), count, count)


def main():
    parser = argparse.ArgumentParser(description='List recent Mail.app messages')
    parser.add_argument('--mailbox', default='Inbox')
    parser.add_argument('--count', type=int, default=10)
    parser.add_argument('--json', action='store_true')
    args = parser.parse_args()

    script = build_applescript(args.mailbox, args.count)
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
            if len(parts) >= 2:
                items.append({
                    'subject': parts[0],
                    'sender': parts[1],
                    'date_received': parts[2] if len(parts) > 2 else None,
                })
        out['messages'] = items
        print(json.dumps(out, indent=2))
    sys.exit(0 if out['success'] else 1)


if __name__ == '__main__':
    main()
