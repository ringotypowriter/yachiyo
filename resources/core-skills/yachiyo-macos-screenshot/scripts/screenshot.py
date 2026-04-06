#!/usr/bin/env python3
import argparse
import datetime
import json
import os
import shlex
import subprocess
import sys
import tempfile


def build_screencapture_args(mode, cursor, no_shadow, clipboard):
    args = ['screencapture', '-x']
    if cursor:
        args.append('-C')
    if no_shadow:
        args.append('-o')
    if clipboard:
        args.append('-c')
    if mode == 'window':
        args.append('-W')
    elif mode == 'area':
        args.append('-i')
    return args


def build_applescript(shell_cmd):
    return 'do shell script "%s"' % shell_cmd.replace('"', '\\"')


def main():
    parser = argparse.ArgumentParser(description='Capture a screenshot on macOS via AppleScript')
    parser.add_argument(
        '--output', '-o',
        help='Output file path (PNG). Defaults to a temp file unless --clipboard is used.'
    )
    parser.add_argument(
        '--mode', '-m', choices=['fullscreen', 'window', 'area'], default='fullscreen',
        help='Capture mode: fullscreen (default), window (interactive), or area (interactive)'
    )
    parser.add_argument('--cursor', '-C', action='store_true', help='Include the cursor in the capture')
    parser.add_argument('--no-shadow', action='store_true', help='Omit window shadow in window mode')
    parser.add_argument('--clipboard', action='store_true', help='Copy capture to clipboard instead of saving to a file')
    parser.add_argument('--json', action='store_true')
    args = parser.parse_args()

    if not args.clipboard and not args.output:
        timestamp = datetime.datetime.now().strftime('%Y%m%d-%H%M%S')
        args.output = os.path.join(tempfile.gettempdir(), f'yachiyo-screenshot-{timestamp}.png')

    sc_args = build_screencapture_args(args.mode, args.cursor, args.no_shadow, args.clipboard)
    if not args.clipboard:
        sc_args.append(args.output)

    shell_cmd = ' '.join(shlex.quote(arg) for arg in sc_args)
    script = build_applescript(shell_cmd)

    try:
        result = subprocess.run(['osascript', '-'], input=script, text=True, capture_output=True, timeout=30)
    except subprocess.TimeoutExpired as exc:
        out = {
            'success': False,
            'stdout': (exc.stdout or '').strip(),
            'stderr': f"{(exc.stderr or '').strip()}\nTimed out waiting for screenshot capture.",
            'path': None,
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
        'path': None if args.clipboard else args.output,
        'mode': args.mode,
        'clipboard': args.clipboard,
    }

    if args.json:
        print(json.dumps(out, indent=2))
    elif out['success']:
        if args.clipboard:
            print('Screenshot copied to clipboard.')
        else:
            print(args.output)
    else:
        print(out['stderr'])

    sys.exit(0 if out['success'] else 1)


if __name__ == '__main__':
    main()
