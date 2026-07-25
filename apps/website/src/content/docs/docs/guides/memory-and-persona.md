---
title: Memory and persona
description: Durable memory, SOUL.md, and USER.md — the three things that make Yachiyo consistent across threads and channels.
---

Three separate mechanisms decide what Yachiyo carries between conversations.
They are easy to confuse, so:

|               | What it holds                               | Who writes it                                  |
| ------------- | ------------------------------------------- | ---------------------------------------------- |
| **Memory**    | Discrete facts, decisions, preferences      | The agent, via `remember` or auto-distillation |
| **`SOUL.md`** | The assistant's persona and evolving traits | You and the agent                              |
| **`USER.md`** | Who you are, as structured tables           | The agent, via `updateProfile`                 |

## Memory

Memory is a local store of terms: each one has a topic, a type, content, an
importance score, and activation metadata (how often it has been recalled, when
it was last used). Relevant terms are pulled into a run's context automatically.

Two settings in **Settings → Sources → Memory**:

- **Enable memory** — pulls recalled context into runs and allows explicit saves.
  On by default.
- **Auto-distill after runs** — the tool model reviews finished runs and writes
  what is worth keeping. Off means memory only changes when the agent explicitly
  calls `remember`.

The same pane lists every stored term grouped by topic, with a **Forget** action
per row. Forgetting is permanent.

### What makes a good memory

The `remember` tool asks for structured facts rather than narrative, with
generous "activation subjects" so the memory surfaces later, and a stable key
that will still make sense in six months. Ask the agent to remember something
and it applies those rules; if you want to see or fix what it stored, the terms
list is the place.

## SOUL.md

`~/.yachiyo/SOUL.md` is the assistant's own document — how it behaves, how it
talks, what it tends toward. Part of it is a **trait log**: dated observations
that accumulate over time, so the persona drifts with use rather than staying
frozen at whatever you wrote on day one.

The direct way to change it is to say so:

> From now on, state the tradeoff before the recommendation.

It can edit its own soul document, and a trait phrased as a durable preference
lands better than one you write about yourself in the third person.

Editing by hand works too — in the app, or from the CLI:

```bash
yachiyo soul traits list
yachiyo soul traits add "States the tradeoff before the recommendation"
yachiyo soul traits remove <key>
```

Added traits are filed under today's date heading. `remove` takes the hash `key`
from `list`, not a position. See the [`soul` CLI reference](/docs/cli/soul/).

## USER.md

`~/.yachiyo/USER.md` is your profile, and it is not free text — each section is a
Markdown table with a fixed schema, which is what lets the agent update one row
without rewriting the document.

The sections depend on who is talking:

**Owner (you):**

| Section             | Columns     |
| ------------------- | ----------- |
| Profile             | Key, Value  |
| Preferences         | Key, Value  |
| Collaboration Notes | Topic, Note |

**Guest (someone reaching you through a channel):**

| Section     | Columns     |
| ----------- | ----------- |
| Profile     | Key, Value  |
| Preferences | Key, Value  |
| Notes       | Topic, Note |

**Group (a group chat):**

| Section     | Columns                   | Notes                            |
| ----------- | ------------------------- | -------------------------------- |
| People      | Nickname, Identity, Notes |                                  |
| Group Vibe  | Aspect, Description       | max 8 rows, expires after 7 days |
| Topic Hints | Topic, Hint               | max 6 rows, expires after 3 days |

Every row also carries a `Since` timestamp, managed automatically. The row caps
and TTLs on group sections are deliberate — a group's vibe is a rolling
impression, not an archive.

The agent maintains all of this through the `updateProfile` tool. You can edit
the file directly too; it is just Markdown.

## Privacy boundaries

- Threads marked **private** are excluded from search and CLI listings unless you
  pass `--include-private`.
- Guest conversations get **filtered memory**: keywords listed in
  `memoryFilterKeywords` are redacted from memory results, so a Telegram
  stranger cannot pull your notes out of the assistant.
- Guests get their own `USER.md` mode, so what the agent learns about a visitor
  never lands in your profile.

See [Channels](/docs/guides/channels/) for the rest of the guest model.
