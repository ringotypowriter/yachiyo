---
title: yachiyo send
description: Push OS notifications and send channel messages from scripts. Requires the app to be running.
---

Fire-and-forget commands that talk to the running Yachiyo app over the Unix
domain socket at `~/.yachiyo/yachiyo.sock`.

:::caution[The app must be running]
Unlike the rest of the CLI, `send` needs a live app. Without one you get:

```
Yachiyo app is not running. Start the app first.
```

:::

## `send notification`

```bash
yachiyo send notification <message> [--title <title>]
```

Pushes a native OS notification.

| Argument          | Description                  |
| ----------------- | ---------------------------- |
| `<message>`       | Body text (required)         |
| `--title <title>` | Title, defaults to `Yachiyo` |

```bash
yachiyo send notification "Build completed"
yachiyo send notification "Tests passed" --title "CI Result"
```

Output: `Notification sent.`

This is the easy win for long-running work:

```bash
pnpm run build && yachiyo send notification "Build done" --title "yachiyo"
```

## `send channel`

```bash
yachiyo send channel <id> <message>
```

Sends text directly to a channel user or group on their platform, as the bot. No
thread is created and no inference runs — the message goes straight out.

| Argument    | Description                              |
| ----------- | ---------------------------------------- |
| `<id>`      | Internal UUID of a channel user or group |
| `<message>` | The text to deliver                      |

Get IDs from [`channel users` or `channel groups`](/docs/cli/channel/):

```bash
yachiyo channel users --json
yachiyo send channel a1b2c3d4-... "Hello from the CLI"
```

Output: `Message sent.`

### Caveats

- The channel service for that platform must be running. If it is not, the send
  fails silently from your side and is logged server-side.
- For QQ, a user ID sends a private message and a group ID sends a group message.
