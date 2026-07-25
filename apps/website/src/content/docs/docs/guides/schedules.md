---
title: Schedules
description: Run prompts on a cron schedule or at a specific time, with run history and result reporting.
---

A schedule runs a prompt without you being there. Each fire creates a fresh
thread, sends the prompt, lets the agent work with full tool access, records the
result, and archives the thread.

The quickest way to make one is to describe it:

> Every weekday at 8am, check `~/projects/api` for dependency updates from the
> last day and tell me about anything with a major version bump.

Yachiyo turns that into a cron expression, a workspace, and — the part people get
wrong by hand — a prompt written to survive with no human present. It knows the
rules below because they are in its help skill.

You can also use **Settings → Schedules** or [the CLI](/docs/cli/schedule/)
directly. The rest of this page is what is actually happening underneath, which
is worth knowing when a schedule misbehaves.

## Two modes

Every schedule is one or the other — setting both or neither is rejected.

- **Recurring** (`cronExpression`) — fires on a cron schedule and re-arms after
  each run. Persists until deleted.
- **One-off** (`runAt`) — fires once at an ISO datetime, then disables itself so
  the run history stays visible.

To switch between them, set the new field and set the old one to `null`.

## What happens on a fire

1. **Connectivity check.** Offline means the run is recorded as `skipped` and no
   model call is made. Recurring schedules retry at the next tick; one-offs do
   not.
2. **Overlap guard.** If the previous run of the same schedule is still going,
   this fire is dropped. A schedule never runs twice in parallel.
3. **Thread creation.** A new thread titled `Schedule: <name>` with the
   configured workspace. Scheduled runs are first-party local threads — full
   memory recall, all tools.
4. **Prompt delivery.** The prompt is sent as the first user message, with the
   `reportScheduleResult` tool added to the normal tool set.
5. **Completion.** Results and token counts are recorded and a system
   notification fires.
6. **Archival.** The thread is auto-archived. The workspace directory is left
   alone.
7. **Re-arm or disable**, depending on the mode.

:::caution
Schedules only fire while the Yachiyo app is running. If you want them to be
reliable, set the app to [launch on login](/docs/install/#launch-on-login).
:::

## Cron expressions

Five fields in your local timezone: `minute hour day-of-month month day-of-week`.
Ranges are `0–59`, `0–23`, `1–31`, `1–12`, `0–7` (0 and 7 both mean Sunday).

| Expression          | Meaning                             |
| ------------------- | ----------------------------------- |
| `0 9 * * *`         | Daily at 09:00                      |
| `*/30 * * * *`      | Every 30 minutes                    |
| `0 * * * *`         | Every hour                          |
| `0 10 * * 1`        | Mondays at 10:00                    |
| `0 0 1 * *`         | First of the month, midnight        |
| `0 */6 * * 1-5`     | Every 6 hours on weekdays           |
| `0 8,12,17 * * 1-5` | Weekdays at 08:00, 12:00, and 17:00 |

## Writing a prompt that survives on its own

The agent executing a scheduled run has nobody to ask. Prompts that work
interactively often fail here — which is the main reason to let Yachiyo write the
prompt rather than pasting in the one-liner you would have typed in chat.

If you are writing it yourself:

**Do:**

- Make it self-contained — exact paths, exact commands, what "done" looks like.
- Set `workspacePath` when the task touches files.
- Use relative time language ("in the last 24 hours"), never hardcoded dates, for
  recurring schedules.
- End with an explicit instruction to call `reportScheduleResult`.

**Do not:**

- Leave it open-ended, or depend on context from a conversation the run cannot
  see.

A workable shape:

> Check `~/projects/api` for dependency updates released in the last 24 hours.
> Run `pnpm outdated --json` and summarize anything with a major version bump.
> When done, call `reportScheduleResult` with status `success` and a
> one-sentence summary, or `failure` with a brief explanation if it could not be
> completed.

## Reading the results

Two statuses, and conflating them will confuse you.

**Run status** — did the machinery work?

| Value       | Meaning                                                             |
| ----------- | ------------------------------------------------------------------- |
| `running`   | In progress                                                         |
| `completed` | The model responded. Says nothing about whether the task succeeded. |
| `failed`    | Terminated with an error; see the `error` field                     |
| `skipped`   | Offline at fire time; the model was never called                    |

**Result status** — did the _task_ work? Only present when the agent called
`reportScheduleResult`:

| Value     | Meaning                                                       |
| --------- | ------------------------------------------------------------- |
| `success` | Agent reported the task complete                              |
| `failure` | Agent reported it could not be done; `resultSummary` says why |
| _absent_  | The agent never called the tool — fix the prompt              |

Run history lives in **Settings → Schedules → History**, or:

```bash
yachiyo schedule runs                  # recent runs, all schedules
yachiyo schedule runs <schedule-id>    # one schedule
```

## Bundled schedules

Two schedules ship with Yachiyo. You can disable them, but not delete them, and
their prompt text is refreshed on upgrade while your cron and enabled/disabled
preferences are preserved.

| Schedule                | Default        | What it does                                                                                                                        |
| ----------------------- | -------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| **Self-Review**         | Daily at 12:00 | Reads recent threads and their tool-call history, looking for concrete ways to do better — not to summarize for you.                |
| **Things Daily Review** | Daily at 22:00 | Indexes the day's activity against existing [Things](/docs/concepts/#things), attaching conversations to the topics they belong to. |

## When something does not fire

| Symptom                                     | Check                                                                                                      |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Never fired                                 | Is it enabled (`✓` in `schedule list`)? Is the app running? Does the cron expression mean what you think?  |
| `skipped`                                   | Machine was offline. Recurring retries; a one-off is now disabled — re-enable to retry the same `runAt`.   |
| `failed` with "Interrupted by app restart." | The app closed mid-run. The run's `threadId` points at the archived thread, which may hold partial work.   |
| `completed`, no result status               | The prompt did not tell the agent to call `reportScheduleResult`. Past runs cannot be fixed retroactively. |
| `completed`, result `failure`               | Read `resultSummary`. Usually wrong paths, missing permissions, or an over-restricted `enabledTools`.      |
| CLI change not showing up                   | The running app picks up CLI changes within about 60 seconds. Settings UI changes are immediate.           |

On startup, any run still marked `running` from a previous session is recovered
to `failed` with "Interrupted by app restart." — runs cannot get permanently
stuck.
