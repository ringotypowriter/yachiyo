# Thread Search — CLI Reference

Search all non-archived threads and messages using substring matching (case-insensitive LIKE). Results are pulled directly from the local SQLite database — no running daemon required.

## Commands

### Search threads

```
yachiyo thread search <query> [--limit <n>] [--json]
```

**Default output** (plain text, optimised for LLM consumption):

```
[ThreadID: abc123] 2024-03-15 Role: user Content: …found the relevant text here…
[ThreadID: def456] 2024-03-10 Role: model Content: …here is what I suggested…
```

**Flags:**

| Flag          | Default | Description                                      |
| ------------- | ------- | ------------------------------------------------ |
| `--limit <n>` | `5`     | Maximum number of matching messages to return    |
| `--json`      | off     | Output a raw JSON array for programmatic parsing |

**Examples:**

```bash
yachiyo thread search "deployment steps"
yachiyo thread search "api key" --limit 10
yachiyo thread search "auth" --json
```

The `--db` flag overrides the database path if you use an isolated `YACHIYO_HOME` workspace.
