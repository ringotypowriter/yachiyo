# send — Send notifications and channel messages

Fire-and-forget commands that deliver payloads to the running Yachiyo app via Unix domain socket. The app must be running; otherwise the command fails with a connection error.

## Commands

### `send notification <message> [--title <title>]`

Push a native OS notification.

| Argument         | Description                         |
| ---------------- | ----------------------------------- |
| `<message>`      | Notification body text (required)   |
| `--title <title>`| Notification title (default: "Yachiyo") |

```bash
yachiyo send notification "Build completed"
yachiyo send notification "Tests passed" --title "CI Result"
```

Output: `Notification sent.`

### `send channel <id> <message>`

Send a chat message to a channel user or group by their internal UUID. The app resolves or creates a thread for the target and runs inference. Fire-and-forget — the CLI exits immediately without waiting for the model response.

| Argument    | Description                                              |
| ----------- | -------------------------------------------------------- |
| `<id>`      | Internal UUID of a channel user or group (required)      |
| `<message>` | The message content to send (required)                   |

Get valid IDs from `channel users` or `channel groups`:

```bash
# 1. Find the target ID
yachiyo channel users --json
yachiyo channel groups --json

# 2. Send a message
yachiyo send channel a1b2c3d4-... "Hello from the CLI"
```

Output: `Message sent.`

## Notes

- Both commands communicate via the Unix domain socket at `~/.yachiyo/yachiyo.sock`.
- If the app is not running, the command fails with: `Yachiyo app is not running. Start the app first.`
- `send channel` reuses an existing active thread for the target (within a 24-hour window) or creates a new one.
- The model response is delivered within the app — the CLI does not receive it.
