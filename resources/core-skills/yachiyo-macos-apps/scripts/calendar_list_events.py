#!/usr/bin/env python3
import argparse
import json
import subprocess
import sys


def build_applescript(from_date, to_date, calendar=None):
    from_escaped = from_date.replace('"', '\\"')
    to_escaped = to_date.replace('"', '\\"')
    overlap_filter = 'start date <= date "%s" and end date >= date "%s"' % (to_escaped, from_escaped)
    if calendar:
        return '''tell application "Calendar"
  set out to ""
  tell calendar "%s"
    set evts to (every event whose %s)
    repeat with e in evts
      set out to out & (summary of e) & tab & (start date of e) & tab & (end date of e) & tab & (location of e) & linefeed
    end repeat
  end tell
  return out
end tell''' % (calendar.replace('"', '\\"'), overlap_filter)
    else:
        return '''tell application "Calendar"
  set out to ""
  repeat with cal in calendars
    set evts to (every event of cal whose %s)
    repeat with e in evts
      set out to out & (summary of e) & tab & (start date of e) & tab & (end date of e) & tab & (location of e) & linefeed
    end repeat
  end repeat
  return out
end tell''' % overlap_filter


def main():
    parser = argparse.ArgumentParser(description='List calendar events from Calendar.app')
    parser.add_argument('--from-date', required=True)
    parser.add_argument('--to-date', required=True)
    parser.add_argument('--calendar')
    parser.add_argument('--json', action='store_true')
    args = parser.parse_args()

    script = build_applescript(args.from_date, args.to_date, args.calendar)
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
            if len(parts) >= 3:
                items.append({
                    'summary': parts[0],
                    'start_date': parts[1],
                    'end_date': parts[2],
                    'location': parts[3] if len(parts) > 3 and parts[3] != 'missing value' else None,
                })
        out['events'] = items
        print(json.dumps(out, indent=2))
    sys.exit(0 if out['success'] else 1)


if __name__ == '__main__':
    main()
