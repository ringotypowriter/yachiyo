# send — Send notifications and channel messages

Fire-and-forget commands that deliver payloads to the running Yachiyo app via Unix domain socket. The app must be running; otherwise the command fails with a connection error.

## Commands

### `send notification <message> [--title <title>]`

Push a native OS notification.

| Argument          | Description                             |
| ----------------- | --------------------------------------- |
| `<message>`       | Notification body text (required)       |
| `--title <title>` | Notification title (default: "Yachiyo") |

```bash
yachiyo send notification "Build completed"
yachiyo send notification "Tests passed" --title "CI Result"
```

Output: `Notification sent.`

### `send channel <id> <message>`

Send a text message directly to a channel user or group on their external platform (Telegram, QQ, Discord) as the bot. The message goes straight to the platform — no thread is created and no inference is run. Fire-and-forget.

| Argument    | Description                                         |
| ----------- | --------------------------------------------------- |
| `<id>`      | Internal UUID of a channel user or group (required) |
| `<message>` | The message text to deliver (required)              |

Get valid IDs from `channel users` or `channel groups`:

```bash
# 1. Find the target ID
yachiyo channel users --json
yachiyo channel groups --json

# 2. Send a message directly to their platform
yachiyo send channel a1b2c3d4-... "Hello from the CLI"
```

Output: `Message sent.`

## Notes

- Both commands communicate via the Unix domain socket at `~/.yachiyo/yachiyo.sock`.
- If the app is not running, the command fails with: `Yachiyo app is not running. Start the app first.`
- `send channel` requires the corresponding channel service (Telegram/QQ/Discord) to be running. If the service for the target's platform is not active, the send fails silently (logged server-side).
- For QQ users, the message is sent as a private message. For QQ groups, it is sent as a group message.
