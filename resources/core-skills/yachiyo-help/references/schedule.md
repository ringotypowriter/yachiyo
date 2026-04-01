# Schedule — Agent Reference

Read this before responding to any schedule-related request.

---

## Two Modes — Choose One

Every schedule has exactly one scheduling mode. Determine which the user needs before acting.

**Recurring** (`cronExpression`) — fires repeatedly on a cron schedule. Re-arms automatically after each run. Persists until explicitly deleted.

**One-off** (`runAt`) — fires once at a specific datetime. After the run completes or is skipped, the schedule is automatically disabled so its run history stays visible.

Setting both fields, or neither, is a validation error. Do not leave it ambiguous — pick one from context.

---

## What Happens When a Schedule Fires

1. **Connectivity check** — if the machine is offline, the run is recorded as `skipped` and the schedule re-arms (recurring) or is disabled (one-off). No LLM call is made.
2. **Overlap guard** — if a previous run of the same schedule is still active, the new fire is dropped. Runs of the same schedule never run in parallel.
3. **Thread creation** — a new thread is created, titled `Schedule: <name>`, with the configured workspace. Scheduled runs are treated as first-party local threads: full memory recall, all tools available.
4. **Prompt delivery** — the configured `prompt` is sent as the first user message. The `reportScheduleResult` tool is injected into the run alongside the normal tool set.
5. **Completion** — when the run ends, results and token counts are recorded and a system notification is shown.
6. **Archival** — the thread is auto-archived after the run ends. The workspace directory is not touched.
7. **Re-arm or disable** — recurring schedules re-arm for the next cron tick. One-off schedules are disabled after their first fired attempt.

**Timing notes:**

- Cron expressions use the local system timezone.
- If a one-off's `runAt` is already in the past when the app starts, the run fires immediately on startup.
- CLI changes are picked up by the running app within ~60 seconds. Settings UI changes are immediate.
- On startup, any run still in `running` status from a previous session is recovered to `failed` with the error `"Interrupted by app restart."` Runs cannot be permanently stuck.

---

## The `reportScheduleResult` Tool

Injected into every scheduled run. When you write a prompt for a user, always include an explicit instruction to call it at the end.

| Parameter | Type                       | Description                                                                                          |
| --------- | -------------------------- | ---------------------------------------------------------------------------------------------------- |
| `status`  | `"success"` or `"failure"` | Whether the task was completed.                                                                      |
| `summary` | `string`                   | One or two sentences on what was done or what went wrong. Shown in the notification and run history. |

If the agent ends without calling it, the run reaches `completed` but `resultStatus` will be absent. The prompt is your only reliable way to ensure it gets called.

---

## Run and Result Statuses

**Run status:**

| Value       | Meaning                                                                                                      |
| ----------- | ------------------------------------------------------------------------------------------------------------ |
| `running`   | In progress. If seen after an app restart, the run was interrupted and will have been recovered to `failed`. |
| `completed` | The LLM responded. Does **not** mean the task succeeded — check `resultStatus`.                              |
| `failed`    | Terminated with an error. The `error` field contains the reason.                                             |
| `skipped`   | No internet at fire time. LLM was never called.                                                              |

**Result status** (only present when `reportScheduleResult` was called):

| Value      | Meaning                                                                   |
| ---------- | ------------------------------------------------------------------------- |
| `success`  | Agent reported task completed.                                            |
| `failure`  | Agent reported task could not be completed. `resultSummary` explains why. |
| _(absent)_ | Agent did not call `reportScheduleResult`.                                |

---

## CLI Commands

### List

```
yachiyo schedule list [--json]
```

Plain output — one line per schedule, e.g.:

```
✓ daily-standup [0 9 * * *] id=abc123
✗ q1-review [@2026-04-01T09:00:00.000Z] id=def456
```

`✓` enabled, `✗` disabled. Recurring shows the cron expression; one-off shows `@<runAt>`.

### Create

```
yachiyo schedule add --payload '<json>'
```

Required: `name`, `prompt`, and exactly one of `cronExpression` / `runAt`.

| Field            | Type       | Required | Notes                                                                                                               |
| ---------------- | ---------- | -------- | ------------------------------------------------------------------------------------------------------------------- |
| `name`           | `string`   | yes      | Used in thread title and notifications.                                                                             |
| `cronExpression` | `string`   | one-of   | Five-field cron, local timezone.                                                                                    |
| `runAt`          | `string`   | one-of   | ISO 8601 datetime. Fires once, then becomes disabled.                                                               |
| `prompt`         | `string`   | yes      | Full text of the message sent on each run. Must be self-contained.                                                  |
| `workspacePath`  | `string`   | no       | Absolute path. If omitted, a per-schedule temp dir is auto-created and reused.                                      |
| `modelOverride`  | `object`   | no       | `{ "providerName": "...", "model": "..." }`. Always run `yachiyo provider models` first — never guess these values. |
| `enabledTools`   | `string[]` | no       | Tool whitelist. Omit for all tools. Pass `[]` to disable all tools.                                                 |
| `enabled`        | `boolean`  | no       | Defaults to `true`.                                                                                                 |

### Remove

```
yachiyo schedule remove <id>
```

Permanently deletes the schedule and its run history. Irreversible. For one-off schedules, use this to cancel before `runAt` or to remove a previously fired disabled one-off.

### Enable / disable

```
yachiyo schedule enable <id>
yachiyo schedule disable <id>
```

Keeps config and history intact. Re-enabling a recurring schedule arms it for the next cron tick — missed ticks are not backfilled. Re-enabling a one-off whose `runAt` has passed causes it to fire within ~60 seconds.

### Run history

```
yachiyo schedule runs [<schedule-id>] [--limit <n>] [--json]
```

Without an ID: recent runs across all schedules, newest first. With an ID: runs for that schedule only. Default limit 20.

---

## Updating Schedules and Switching Modes

Schedules are updated through the Settings UI. Only fields you provide are changed. Pass `null` to clear a field.

To switch recurring → one-off: set `runAt`, set `cronExpression` to `null`.
To switch one-off → recurring: set `cronExpression`, set `runAt` to `null`.

The result must always have exactly one scheduling field — the system rejects updates that leave both or neither set.

Other nullable fields:

| Field           | Effect of `null`                          |
| --------------- | ----------------------------------------- |
| `workspacePath` | Reverts to auto temp dir.                 |
| `modelOverride` | Removed; falls back to workspace default. |
| `enabledTools`  | Removed; all tools become available.      |

---

## Cron Expression Reference

Five fields, local timezone: `minute  hour  day-of-month  month  day-of-week`

Ranges `0–59`, `0–23`, `1–31`, `1–12`, `0–7` (0 and 7 = Sunday). Special syntax: `*` any, `*/n` every nth, `a-b` range, `a,b` list.

| Expression          | Meaning                          |
| ------------------- | -------------------------------- |
| `0 9 * * *`         | Daily at 09:00                   |
| `*/30 * * * *`      | Every 30 minutes                 |
| `0 * * * *`         | Every hour                       |
| `0 10 * * 1`        | Every Monday at 10:00            |
| `0 0 1 * *`         | First of every month at midnight |
| `0 */6 * * 1-5`     | Every 6 hours, weekdays          |
| `0 8,12,17 * * 1-5` | Weekdays at 08:00, 12:00, 17:00  |

---

## Writing Prompts for Scheduled Runs

When constructing the `prompt` field for a user, apply these rules. The agent that executes it has no human to ask for clarification.

**Always:**

- Make the prompt fully self-contained. Specify exact paths, commands, and expected outputs.
- End with an explicit `reportScheduleResult` instruction, e.g.: _"When done, call `reportScheduleResult` with `status` 'success' and a one-sentence summary, or 'failure' with a brief explanation if the task could not be completed."_
- Use `workspacePath` when the task reads or writes files.
- For recurring prompts, use relative time language ("in the last 24 hours") not hardcoded dates.

**Never:**

- Leave the task open-ended or dependent on context the agent cannot access.
- Omit the `reportScheduleResult` instruction.

---

## Diagnosing Problems

**Schedule never fired:**

- Check `schedule list` — is it enabled (`✓`)?
- Is the app running? Schedules only fire while the app is open.
- For recurring: does the cron expression produce the expected next-fire time?
- For one-off: is `runAt` in the future? If the time has passed and it no longer appears in the list, it already fired — check `schedule runs`.

**Run is `skipped`:**
Machine was offline at fire time. Recurring will retry at the next tick. One-off will not retry — the schedule is now disabled. Re-enable it to retry the same `runAt`, or create a new one-off with a future time.

**Run is `failed` with `"Interrupted by app restart."`:**
The app was closed mid-run. The `threadId` in the run record points to the archived thread, which may contain partial work.

**Run is `completed`, `resultStatus` absent:**
The agent did not call `reportScheduleResult`. Update the prompt to include an explicit instruction. Past runs cannot be retroactively fixed.

**Run is `completed`, `resultStatus` is `failure`:**
The agent reported failure. Read `resultSummary`. Common causes: wrong file paths, missing permissions, overly restricted `enabledTools`, or a genuinely failing task. Adjust the prompt or config.

**CLI change not reflected:**
The app picks up CLI changes within ~60 seconds. If it has been longer, verify with `schedule list --json`. Settings UI changes are immediate.
