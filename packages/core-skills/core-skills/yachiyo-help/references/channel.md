# channel — List channel users/groups and change group monitor status

Discover registered channel users and groups. Use the `id` field from the output with `send channel` to deliver messages.
For group channels, you can also change the monitor status directly from the CLI.

## Commands

### `channel users [--json]`

List all registered channel users across platforms (telegram, qq, discord).

**Without `--json`:** compact summary lines

```
[allowed] telegram:alice id=a1b2c3d4-...
[pending] qq:bob id=e5f6g7h8-...
```

**With `--json`:** full JSON array of user records

```json
[
  {
    "id": "a1b2c3d4-...",
    "platform": "telegram",
    "externalUserId": "123456",
    "username": "alice",
    "status": "allowed",
    "role": "guest",
    "usageLimitKTokens": null,
    "usedKTokens": 42,
    "workspacePath": "/tmp/yachiyo/tg-alice"
  }
]
```

### `channel groups [--json]`

List all registered channel groups across platforms.

**Without `--json`:** compact summary lines

```
[approved] discord:dev-chat id=x9y8z7w6-...
[pending] qq:test-group id=m1n2o3p4-...
```

**With `--json`:** full JSON array of group records

```json
[
  {
    "id": "x9y8z7w6-...",
    "platform": "discord",
    "externalGroupId": "987654321",
    "name": "dev-chat",
    "status": "approved",
    "workspacePath": "/tmp/yachiyo/discord-dev-chat",
    "createdAt": "2026-03-28T12:00:00.000Z"
  }
]
```

### `channel groups set-status <id> <status>`

Change only a group channel's monitor status.

| Argument   | Description                                                                           |
| ---------- | ------------------------------------------------------------------------------------- |
| `<id>`     | Internal UUID of a channel group (required)                                           |
| `<status>` | Target status. Accepted values: `approved`, `approval`, `pending`, `blocked`, `block` |

Examples:

```bash
# Approve a pending group and start its live monitor immediately if the app is running
yachiyo channel groups set-status x9y8z7w6-... approval

# Stop monitoring a group
yachiyo channel groups set-status x9y8z7w6-... block
```

Behavior:

- If the Yachiyo app is running, the CLI sends the status change over the Unix domain socket at `~/.yachiyo/yachiyo.sock`.
- A live app applies the update immediately, so `approval` starts the group monitor right away and `block`/`blocked` stops it right away.
- If the app is not running, the CLI falls back to updating the saved database record directly.
- This command only accepts group IDs. Passing a channel user ID fails with `Unknown channel group`.

## Fields

### Channel User

| Field               | Description                                 |
| ------------------- | ------------------------------------------- |
| `id`                | Internal UUID. Pass this to `send channel`. |
| `platform`          | `telegram`, `qq`, or `discord`              |
| `externalUserId`    | User's ID on the external platform          |
| `username`          | Display name                                |
| `status`            | `pending`, `allowed`, or `blocked`          |
| `role`              | `owner` or `guest`                          |
| `usageLimitKTokens` | Token quota (null = unlimited)              |
| `usedKTokens`       | Accumulated token usage                     |
| `workspacePath`     | Local workspace directory for this user     |

### Channel Group

| Field             | Description                                 |
| ----------------- | ------------------------------------------- |
| `id`              | Internal UUID. Pass this to `send channel`. |
| `platform`        | `telegram`, `qq`, or `discord`              |
| `externalGroupId` | Group's ID on the external platform         |
| `name`            | Display name                                |
| `status`          | `pending`, `approved`, or `blocked`         |
| `workspacePath`   | Local workspace directory for this group    |
| `createdAt`       | ISO timestamp when the group was registered |

## Notes

- Channel users and channel groups use different status vocabularies.
- Users use `pending`, `allowed`, `blocked`.
- Groups use `pending`, `approved`, `blocked`.
- `channel groups set-status` is group-only and maps the human-friendly alias `approval` to `approved`.
