# Threads — CLI Reference

Inspect and search thread history. All commands read directly from the local SQLite database — no running daemon required. Guest-channel threads are excluded from results.

## Commands

### Search messages

```
yachiyo thread search <query> [--limit <n>] [--json] [--include-private]
```

Full-text search across message history. When the FTS5 index is available (created automatically by the main app on startup), results are ranked by BM25 relevance. If the index is missing or corrupt, the CLI falls back to case-insensitive substring matching (LIKE).

**Default output** (plain text, optimised for LLM consumption):

```
[ThreadID: abc123] 2024-03-15 Role: user Content: …found the relevant text here…
[ThreadID: def456] 2024-03-10 Role: model Content: …here is what I suggested…
```

| Flag                | Default | Description                                          |
| ------------------- | ------- | ---------------------------------------------------- |
| `--limit <n>`       | `5`     | Maximum number of matching messages to return        |
| `--json`            | off     | Output a raw JSON array for programmatic parsing     |
| `--include-private` | off     | Include threads with privacy mode enabled in results |

```bash
yachiyo thread search "deployment steps"
yachiyo thread search "api key" --limit 10
yachiyo thread search "auth" --json
yachiyo thread search "secret project" --include-private
```

### List recent threads

```
yachiyo thread list [--limit <n>] [--json] [--include-private]
```

List recent non-archived threads ordered by `updatedAt` descending. Each entry includes the thread title, first user query, message count, and review status.

**Default output:**

```
[thread-a] Planning session (12 msgs) q: how do we plan Q2?
[thread-b] [reviewed] Bug triage (8 msgs) q: what's failing in CI?
```

| Flag                | Default | Description                                          |
| ------------------- | ------- | ---------------------------------------------------- |
| `--limit <n>`       | `10`    | Maximum number of threads to return                  |
| `--json`            | off     | Output a raw JSON array for programmatic parsing     |
| `--include-private` | off     | Include threads with privacy mode enabled in results |

```bash
yachiyo thread list
yachiyo thread list --limit 3 --json
```

### Show thread

```
yachiyo thread show <id> [--json] [--include-private]
```

Dump all messages of a thread in chronological order, including tool call history. After displaying, the CLI sends a best-effort notification to the running app to mark the thread as reviewed.

**Default output:**

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

| Flag                | Default | Description                                     |
| ------------------- | ------- | ----------------------------------------------- |
| `--json`            | off     | Output the full thread dump as JSON             |
| `--include-private` | off     | Allow showing threads with privacy mode enabled |

```bash
yachiyo thread show abc123
yachiyo thread show abc123 --json
```

## Global flags

The `--db` flag overrides the database path if you use an isolated `YACHIYO_HOME` workspace.

## Search ranking

When the FTS5 index is present, queries are tokenized (Unicode-aware, supports Latin, CJK, kana, Cyrillic, etc.) and matched using SQLite's full-text search with BM25 relevance scoring. Multi-word queries are joined with OR — any matching token contributes to the score.

When the index is unavailable (first run before the app has started, or on a read-only database copy), the CLI uses simple `LIKE %query%` substring matching ordered by thread recency.

## Cross-thread search via searchMemory tool

The agent's `searchMemory` tool supports a `domain: "cross-thread"` option (available in local and owner-DM threads) that uses the same FTS5/BM25 engine to search message history across all threads. This is injected automatically — no CLI flags needed.
