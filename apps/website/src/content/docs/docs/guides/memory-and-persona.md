---
title: Memory and persona
description: Durable memory, SOUL.md, and USER.md — the three things that make Yachiyo consistent across threads and channels.
---

Three separate mechanisms decide what Yachiyo carries between conversations.
They are easy to confuse, so:

|               | What it holds                                | Who writes it                                 |
| ------------- | -------------------------------------------- | --------------------------------------------- |
| **Memory**    | Revisable notes linked to past conversations | The agent, via `remember` or automatic review |
| **`SOUL.md`** | The assistant's persona and evolving traits  | You and the agent                             |
| **`USER.md`** | Who you are, as structured tables            | The agent, via `updateProfile`                |

## Memory

Conversations remain the original record. Memory contains notes that help Yachiyo
find those conversations again: what mattered, why it is worth revisiting, and
any conditions or uncertainty. Notes can be revised or deleted without changing
the original dialogue. Existing structured memories remain readable.

Automatic recall brings a small amount of related context and source references
into a run. Exact quotes, historical decisions, and claims about completed actions
still need the original evidence; a note is not proof.

Two settings in **Settings → Sources → Memory**:

- **Enable memory** — pulls recalled context into runs and allows explicit saves.
  On by default.
- **Auto-distill after runs** — eligible conversations are reviewed in the background
  for a few useful, source-linked notes. Turning this off stops background review;
  `remember` and manual conversation saves remain available.

The same pane lists every stored term grouped by topic, with a **Forget** action
per row. Forgetting removes the stored note, not its source conversation.

### What makes a good memory

`remember` accepts a prose note. The runtime links the current message and tool
invocation automatically; notes about earlier discussions can cite references
returned by `querySource`. An existing note ID allows revision or deletion.
Yachiyo may also write a note when a meaningful decision or correction is worth
carrying forward, rather than recording routine progress every turn.

`querySource` accepts `text` to search original conversations and notes together,
or `ref` to open a source with surrounding dialogue. Search keeps notes separate
from original excerpts and combines overlapping source hits. Conversations do
not need a note to be discoverable. A note whose source is unavailable is shown
without a fabricated excerpt. Advanced table, time, and folder queries remain
available; default discovery uses a bounded result window.

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
