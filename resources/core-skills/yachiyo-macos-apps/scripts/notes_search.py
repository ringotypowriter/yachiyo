#!/usr/bin/env python3
import argparse
import json
import subprocess
import sys


def build_applescript(query, search_body=False):
    query_escaped = query.replace('"', '\\"')
    if search_body:
        return '''tell application "Notes"
  set out to ""
  set q to "%s"
  set nameMatches to (get every note whose name contains q)
  set allIds to {}
  repeat with aNote in nameMatches
    try
      set i to id of aNote as string
      if i is not in allIds then
        set end of allIds to i
        set d to modification date of aNote as string
        set n to name of aNote as string
        set out to out & i & tab & n & tab & d & linefeed
      end if
    end try
  end repeat
  try
    set bodyMatches to (get every note whose body contains q)
    repeat with aNote in bodyMatches
      try
        set i to id of aNote as string
        if i is not in allIds then
          set end of allIds to i
          set d to modification date of aNote as string
          set n to name of aNote as string
          set out to out & i & tab & n & tab & d & linefeed
        end if
      end try
    end repeat
  end try
  return out
end tell''' % (query_escaped,)
    else:
        return '''tell application "Notes"
  set out to ""
  set q to "%s"
  set nameMatches to (get every note whose name contains q)
  repeat with aNote in nameMatches
    try
      set i to id of aNote as string
      set d to modification date of aNote as string
      set n to name of aNote as string
      set out to out & i & tab & n & tab & d & linefeed
    end try
  end repeat
  return out
end tell''' % (query_escaped,)


def main():
    parser = argparse.ArgumentParser(description='Search notes in Notes.app')
    parser.add_argument('--query', required=True)
    parser.add_argument('--search-body', action='store_true',
                        help='Also search note bodies (slower for large libraries)')
    parser.add_argument('--json', action='store_true')
    args = parser.parse_args()

    script = build_applescript(args.query, args.search_body)
    try:
        result = subprocess.run(['osascript', '-'], input=script, text=True, capture_output=True, timeout=15)
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
                    'id': parts[0],
                    'name': parts[1],
                    'modification_date': parts[2] if len(parts) > 2 else None,
                })
        out['notes'] = items
        print(json.dumps(out, indent=2))
    sys.exit(0 if out['success'] else 1)


if __name__ == '__main__':
    main()
