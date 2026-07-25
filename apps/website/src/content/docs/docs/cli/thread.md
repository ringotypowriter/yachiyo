---
title: yachiyo thread
description: Search message history, list recent threads, and dump a full conversation.
---

Reads conversation history straight from the local SQLite database — no running
app required. Guest-channel threads are excluded from results.

Threads with privacy mode enabled are hidden from all three commands unless you
pass `--include-private`.

## `thread search`

```bash
yachiyo thread search <query> [--limit <n>] [--json] [--include-private]
```

Full-text search across message history, ranked by BM25 relevance when the FTS
index is available.

Default output is plain text, one match per line:

```
[ThreadID: abc123] 2026-03-15 Role: user Content: …found the relevant text here…
[ThreadID: def456] 2026-03-10 Role: model Content: …here is what I suggested…
```

| Flag                | Default | Description                  |
| ------------------- | ------- | ---------------------------- |
| `--limit <n>`       | 5       | Maximum matching messages    |
| `--json`            | off     | Raw JSON array               |
| `--include-private` | off     | Include privacy-mode threads |

```bash
yachiyo thread search "deployment steps"
yachiyo thread search "api key" --limit 10
yachiyo thread search "auth" --json
```

### How ranking works

The index uses trigram tokenization, so it handles CJK and other
non-space-delimited scripts as well as it handles English. Multi-word queries are
joined with OR — any matching token contributes to the score.

Queries shorter than three characters fall back to `LIKE` substring matching,
as does the whole command if the index is missing or unreadable (a first run
before the app has ever started, or a read-only copy of the database). Fallback
results are ordered by thread recency rather than relevance.

## `thread list`

```bash
yachiyo thread list [--limit <n>] [--json] [--include-private]
```

Recent non-archived threads, newest activity first. Each entry carries the
title, the first user query, message count, and review status.

```
[thread-a] Planning session (12 msgs) q: how do we plan Q2?
[thread-b] [reviewed] Bug triage (8 msgs) q: what's failing in CI?
```

| Flag                | Default | Description                  |
| ------------------- | ------- | ---------------------------- |
| `--limit <n>`       | 10      | Maximum threads              |
| `--json`            | off     | Raw JSON array               |
| `--include-private` | off     | Include privacy-mode threads |

## `thread show`

```bash
yachiyo thread show <id> [--json] [--include-private]
```

Dumps every message in a thread chronologically, including the tool-call
history. After displaying, it sends a best-effort notification to the running app
marking the thread as reviewed.

```
Thread thread-a: Planning session
Created: 2026-04-05  Updated: 2026-04-07  Messages: 2  Tool calls: 1

── user @ 2026-04-05 08:00 ──
hello

── model @ 2026-04-05 08:00 ──
hi there

── tool calls ──
#1 skillsRead [completed] names=["release-process"]
```

With `--json` you get the full dump including a `toolCalls[]` array — tool name,
status, input and output summaries, errors, and step index. That array is where
causation lives when you are working out why a run went sideways.

## Pointing at another database

```bash
yachiyo thread list --db /path/to/other/yachiyo.sqlite
```

Useful against an isolated `YACHIYO_HOME` workspace or a copy of the database.
