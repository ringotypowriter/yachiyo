# channel — List channel users and groups

Discover registered channel users and groups. Use the `id` field from the output with `send channel` to deliver messages.

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

## Fields

### Channel User

| Field              | Description                                    |
| ------------------ | ---------------------------------------------- |
| `id`               | Internal UUID. Pass this to `send channel`.    |
| `platform`         | `telegram`, `qq`, or `discord`                 |
| `externalUserId`   | User's ID on the external platform             |
| `username`         | Display name                                   |
| `status`           | `pending`, `allowed`, or `blocked`             |
| `role`             | `owner` or `guest`                             |
| `usageLimitKTokens`| Token quota (null = unlimited)                 |
| `usedKTokens`      | Accumulated token usage                        |
| `workspacePath`    | Local workspace directory for this user        |

### Channel Group

| Field              | Description                                    |
| ------------------ | ---------------------------------------------- |
| `id`               | Internal UUID. Pass this to `send channel`.    |
| `platform`         | `telegram`, `qq`, or `discord`                 |
| `externalGroupId`  | Group's ID on the external platform            |
| `name`             | Display name                                   |
| `status`           | `pending`, `approved`, or `blocked`            |
| `workspacePath`    | Local workspace directory for this group       |
| `createdAt`        | ISO timestamp when the group was registered    |
