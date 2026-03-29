# Schedule — CLI Reference

Scheduled tasks run prompts on a cron-based timer. The app executes each enabled schedule automatically, creates a thread, runs the prompt, and archives the thread when done.

## Commands

### List all schedules

```
yachiyo schedule list [--json]
```

Plain output shows one line per schedule: `✓`/`✗` enabled status, name, cron expression, and ID.

### Create a schedule

```
yachiyo schedule add --payload '<json>'
```

The payload must include `name`, `cronExpression`, and `prompt`. All other fields are optional.

**Payload fields:**

| Field            | Type       | Required | Description                                        |
| ---------------- | ---------- | -------- | -------------------------------------------------- |
| `name`           | `string`   | yes      | Human-readable name for the schedule               |
| `cronExpression` | `string`   | yes      | Standard cron expression (parsed by `cron-parser`) |
| `prompt`         | `string`   | yes      | The prompt text sent to the assistant on each run  |
| `workspacePath`  | `string`   | no       | Working directory for the run                      |
| `modelOverride`  | `object`   | no       | Override the model used (`{chatModel, toolModel}`) |
| `enabledTools`   | `string[]` | no       | Restrict which tools the agent may use             |
| `enabled`        | `boolean`  | no       | Defaults to `true`                                 |

**Examples:**

```bash
# Run a daily standup summary at 9 AM
yachiyo schedule add --payload '{
  "name": "daily-standup",
  "cronExpression": "0 9 * * *",
  "prompt": "Summarise the git log from the last 24 hours and list open TODOs."
}'

# Weekly dependency check, scoped to a workspace
yachiyo schedule add --payload '{
  "name": "dep-audit",
  "cronExpression": "0 10 * * 1",
  "prompt": "Run pnpm audit and report any high/critical vulnerabilities.",
  "workspacePath": "/Users/me/projects/my-app"
}'
```

### Remove a schedule

```
yachiyo schedule remove <id>
```

Permanently deletes the schedule. Use `schedule list` to find the ID.

### Enable / disable

```
yachiyo schedule enable <id>
yachiyo schedule disable <id>
```

Toggle a schedule without deleting it. Disabled schedules are kept in the database but will not fire.

### View run history

```
yachiyo schedule runs [<schedule-id>] [--limit <n>] [--json]
```

Without a schedule ID, shows recent runs across all schedules. With an ID, shows runs for that schedule only. Default limit is 20.

Plain output shows one line per run: status, timestamp, and a truncated summary (if available).

## Cron Expression Quick Reference

```
┌───────────── minute (0–59)
│ ┌─────────── hour (0–23)
│ │ ┌───────── day of month (1–31)
│ │ │ ┌─────── month (1–12)
│ │ │ │ ┌───── day of week (0–7, 0 and 7 = Sunday)
│ │ │ │ │
* * * * *
```

| Pattern         | Meaning                   |
| --------------- | ------------------------- |
| `0 9 * * *`     | Every day at 09:00        |
| `*/30 * * * *`  | Every 30 minutes          |
| `0 10 * * 1`    | Every Monday at 10:00     |
| `0 0 1 * *`     | First day of month, 00:00 |
| `0 */6 * * 1-5` | Every 6 hours, weekdays   |

## How Scheduled Runs Work

1. The app polls enabled schedules and fires when a cron expression matches.
2. A new thread is created for the run (with optional `workspacePath`).
3. The prompt is sent as the first user message; the assistant executes it.
4. The agent has a special `reportScheduleResult` tool to report success/failure with a summary.
5. After completion, the thread is automatically archived.
6. Run results (status, summary, token usage) are recorded in the database.

CLI-originated changes (add/remove/enable/disable) are picked up by the running app within ~60 seconds.
