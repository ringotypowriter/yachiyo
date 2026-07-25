---
title: yachiyo schedule
description: Create, update, and inspect scheduled tasks and their run history.
---

Manages the scheduled tasks described in [Schedules](/docs/guides/schedules/).

## `schedule list`

```bash
yachiyo schedule list [--json]
```

One line per schedule:

```
✓ daily-standup [0 9 * * *] id=abc123
✗ q1-review [@2026-04-01T09:00:00.000Z] id=def456
```

`✓` enabled, `✗` disabled. Recurring shows the cron expression; one-off shows
`@<runAt>`.

## `schedule add`

```bash
yachiyo schedule add --payload '<json>'
```

Requires `name`, `prompt`, and **exactly one** of `cronExpression` or `runAt`.
Supplying both or neither is a validation error.

| Field            | Type       | Required | Notes                                                                      |
| ---------------- | ---------- | -------- | -------------------------------------------------------------------------- |
| `name`           | `string`   | yes      | Used in the thread title and notifications                                 |
| `prompt`         | `string`   | yes      | Sent as the first user message. Must be self-contained.                    |
| `cronExpression` | `string`   | one of   | Five-field cron, local timezone                                            |
| `runAt`          | `string`   | one of   | ISO 8601 datetime; fires once, then disables itself                        |
| `workspacePath`  | `string`   | no       | Absolute path. Omitted means an auto-created temp dir, reused across runs. |
| `modelOverride`  | `object`   | no       | `{ "providerName": "...", "model": "..." }`                                |
| `enabledTools`   | `string[]` | no       | Tool whitelist. Omit for all tools; `[]` disables all.                     |
| `enabled`        | `boolean`  | no       | Defaults to `true`                                                         |

```bash
yachiyo schedule add --payload '{
  "name": "morning-digest",
  "cronExpression": "0 8 * * 1-5",
  "prompt": "Summarize unread items in ~/notes/inbox.md from the last 24 hours. When done, call reportScheduleResult with status success and a one-sentence summary.",
  "workspacePath": "/Users/me/notes"
}'
```

:::tip
Run `yachiyo provider models` first and copy a real model name into
`modelOverride`. A guessed model string fails at request time, inside a run you
are not watching.
:::

## `schedule update`

```bash
yachiyo schedule update --payload '<json>'
```

The payload must include `id`. Any of `name`, `prompt`, `cronExpression`,
`runAt`, `workspacePath`, `modelOverride`, `enabledTools`, and `enabled` may be
supplied; only what you pass changes. Pass `null` to clear a field.

Switching modes means setting one and clearing the other:

```bash
# recurring → one-off
yachiyo schedule update --payload '{"id":"abc123","runAt":"2026-08-01T09:00:00.000Z","cronExpression":null}'

# one-off → recurring
yachiyo schedule update --payload '{"id":"abc123","cronExpression":"0 9 * * *","runAt":null}'
```

The result must always have exactly one scheduling field set.

| Field           | Effect of `null`                             |
| --------------- | -------------------------------------------- |
| `workspacePath` | Reverts to an auto temp dir                  |
| `modelOverride` | Removed; falls back to the workspace default |
| `enabledTools`  | Removed; all tools become available          |

Bundled schedules accept only `enabled` and `cronExpression` changes.

## `schedule remove`

```bash
yachiyo schedule remove <id>
```

Deletes the schedule and its run history. Irreversible, and the way to cancel a
one-off before it fires. Bundled schedules cannot be removed — disable them
instead.

## `schedule enable` / `disable`

```bash
yachiyo schedule enable <id>
yachiyo schedule disable <id>
```

Config and history are kept either way. Re-enabling a recurring schedule arms it
for the next tick — missed ticks are not backfilled. Re-enabling a one-off whose
`runAt` has passed makes it fire within about 60 seconds.

## `schedule runs`

```bash
yachiyo schedule runs [<schedule-id>] [--limit <n>] [--json]
```

Recent runs, newest first — across all schedules, or for one. Default limit 20.

Each run carries a run status (`running`, `completed`, `failed`, `skipped`) and,
when the agent called `reportScheduleResult`, a result status (`success` or
`failure`) with a summary. The two mean different things — see
[reading the results](/docs/guides/schedules/#reading-the-results).
