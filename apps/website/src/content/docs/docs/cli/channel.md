---
title: yachiyo channel
description: List channel users and groups, label them, and change a group's monitor status.
---

Inspects the users and groups registered across your channel platforms. The `id`
values from these commands are what [`yachiyo send channel`](/docs/cli/send/)
takes.

## `channel users`

```bash
yachiyo channel users [--json]
```

Compact output:

```
[allowed] telegram:alice id=a1b2c3d4-...
[pending] qq:bob id=e5f6g7h8-...
```

With `--json`, full records:

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

| Field               | Description                                 |
| ------------------- | ------------------------------------------- |
| `id`                | Internal UUID — pass this to `send channel` |
| `platform`          | `telegram`, `qq`, or `discord`              |
| `externalUserId`    | Their ID on the platform                    |
| `username`          | Display name                                |
| `status`            | `pending`, `allowed`, or `blocked`          |
| `role`              | `owner` or `guest`                          |
| `usageLimitKTokens` | Token quota; `null` means unlimited         |
| `usedKTokens`       | Accumulated usage                           |
| `workspacePath`     | This user's sandboxed workspace             |

## `channel groups`

```bash
yachiyo channel groups [--json]
```

```
[approved] discord:dev-chat id=x9y8z7w6-...
[pending] qq:test-group id=m1n2o3p4-...
```

| Field             | Description                         |
| ----------------- | ----------------------------------- |
| `id`              | Internal UUID                       |
| `platform`        | `telegram`, `qq`, or `discord`      |
| `externalGroupId` | The group's ID on the platform      |
| `name`            | Display name                        |
| `status`          | `pending`, `approved`, or `blocked` |
| `workspacePath`   | The group's sandboxed workspace     |
| `createdAt`       | When the group was registered       |

:::note[Two vocabularies]
Users are `pending` / `allowed` / `blocked`. Groups are `pending` / `approved` /
`blocked`. They are not interchangeable.
:::

## `channel groups set-status`

```bash
yachiyo channel groups set-status <id> <status>
```

Accepted values: `approved` or `approval`, `pending`, `blocked` or `block`.

```bash
yachiyo channel groups set-status x9y8z7w6-... approval   # start monitoring
yachiyo channel groups set-status x9y8z7w6-... block      # stop monitoring
```

If the app is running, the change goes over its local command endpoint and
applies immediately — `approval` starts the group monitor right away, `block`
stops it. If the app is not running, the database record is updated directly
instead.

This command is group-only. Passing a channel **user** ID fails with
`Unknown channel group`.

## `channel users set-label` / `channel groups set-label`

```bash
yachiyo channel users set-label <id> <label>
yachiyo channel groups set-label <id> <label>
```

Attaches a descriptive label. Labels are what the agent uses to work out who a
contact is or what a group is for, so "Design team standup" beats leaving it
blank.

## See also

- [Channels](/docs/guides/channels/) — platform setup and the guest model
- [`yachiyo send`](/docs/cli/send/) — deliver a message to one of these IDs
