#!/usr/bin/env python3
import argparse
import json
import subprocess
import sys


def build_applescript(to, subject, body, cc=None, bcc=None, send=False):
    subject_escaped = subject.replace('"', '\\"')
    body_escaped = body.replace('"', '\\"')
    lines = ['tell application "Mail"']
    lines.append(
        '  set newMessage to make new outgoing message with properties {subject:"%s", content:"%s"}'
        % (subject_escaped, body_escaped)
    )
    for addr in to:
        lines.append(
            '  make new to recipient at end of to recipients of newMessage with properties {address:"%s"}'
            % addr.replace('"', '\\"')
        )
    if cc:
        for addr in cc:
            lines.append(
                '  make new cc recipient at end of cc recipients of newMessage with properties {address:"%s"}'
                % addr.replace('"', '\\"')
            )
    if bcc:
        for addr in bcc:
            lines.append(
                '  make new bcc recipient at end of bcc recipients of newMessage with properties {address:"%s"}'
                % addr.replace('"', '\\"')
            )
    if send:
        lines.append('  send newMessage')
    else:
        lines.append('  set visible of newMessage to true')
    lines.append('end tell')
    return '\n'.join(lines)


def main():
    parser = argparse.ArgumentParser(description='Compose an email via Mail.app')
    parser.add_argument('--to', required=True, action='append', help='Recipient email (repeatable)')
    parser.add_argument('--subject', required=True)
    parser.add_argument('--body', required=True)
    parser.add_argument('--cc', action='append')
    parser.add_argument('--bcc', action='append')
    parser.add_argument('--send', action='store_true', help='Send immediately instead of opening the compose window')
    parser.add_argument('--json', action='store_true')
    args = parser.parse_args()

    script = build_applescript(args.to, args.subject, args.body, args.cc, args.bcc, args.send)
    try:
        result = subprocess.run(['osascript', '-'], input=script, text=True, capture_output=True, timeout=8)
    except subprocess.TimeoutExpired as exc:
        out = {
            'success': False,
            'stdout': (exc.stdout or '').strip(),
            'stderr': f"{(exc.stderr or '').strip()}\nTimed out waiting for macOS app response.",
            'send': args.send,
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
        'send': args.send,
    }
    if args.json:
        print(json.dumps(out, indent=2))
    else:
        print(out['stdout'] or out['stderr'])
    sys.exit(0 if out['success'] else 1)


if __name__ == '__main__':
    main()
