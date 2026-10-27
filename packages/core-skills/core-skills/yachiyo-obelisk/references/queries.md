# Query examples

Each query is a JavaScript file. `return` emits JSON. Use a fresh temporary path
for each query. Keep a unique literal marker in the script so Obelisk can identify
the invoking session even when the shell expands the filename. Change the marker
for each invocation; do not reuse this example's literal value.

```bash
query_dir=$(mktemp -d)
cat > "$query_dir/query.mjs" <<'JS'
// obq-yachiyo-unique-literal-marker
return overview({ limit: 5, projectLimit: 10, memoryLimit: 10 })
JS
obelisk --query "$query_dir/query.mjs"
```

Use the returned project slug exactly. `overview().current.project` may be null;
choose a relevant project from `projects` before broadening the search.

```js
const project = 'PROJECT_SLUG_FROM_OVERVIEW'
const knowledge = memories({ query: 'error or feature', project, limit: 5 })
const hits = search('error filename', { project, limit: 12, fallback: 'or' }).filter(
  (hit) => !hit.session.is_invoking
)
return { knowledge, hits }
```

The `fallback: 'or'` option retries safe words only when the first search is empty.
Keep exact searches strict when zero matches matters. Add `source: 'yachiyo'` to
`search` or `sessions` to inspect Yachiyo alone. Omit it to search all agents.

## Chinese and other substring queries

`sql(query, ...params)` binds values as parameters. Use `instr()` for literal
substring matching. This avoids treating `%` or `_` in the user's text as wildcards.
Keep the project, visibility, meta, and invoking-session filters.

```js
const scope = overview()
const project = 'PROJECT_SLUG_FROM_OVERVIEW'
const keyword = '历史检索'
const self = scope.current.session_id
const hits = sql(
  `
  SELECT s.id AS session_id, s.title, s.source,
         m.uuid, m.role, m.timestamp, substr(m.text, 1, 800) AS excerpt
  FROM messages m JOIN sessions s ON s.id = m.session_id
  WHERE s.project = ? AND m.visibility = 'visible' AND m.is_meta = 0
    AND (? IS NULL OR s.id <> ?) AND instr(m.text, ?) > 0
  ORDER BY m.timestamp DESC, m.uuid DESC LIMIT 12
`,
  project,
  self,
  self,
  keyword
)
return { invokingSessionKnown: self !== null, hits }
```

For a known session, replace `s.project = ?` with `s.id = ?`. To widen by date,
add `m.timestamp >= ?` with an ISO timestamp. Search only the necessary scope.

## Expand and verify

```js
return messages({ around: 'MESSAGE_UUID', relation: 'parents', beforeCount: 4 })
```

```js
return messages({ sessionId: 'SESSION_ID', limit: 20 })
```

`messages` returns an envelope with `messages`, `nextCursor`, and `hasMore`.
Follow its cursor only when more context is needed. `includeInactive: true` is
for inspecting superseded branches deliberately. Ordinary answers should use
the default visible transcript.

```js
return raw('MESSAGE_UUID', { offset: 0, limit: 6000 })
```

Raw source records may contain text that was hidden, superseded, or never sent
to a channel. Preserve that distinction in the answer. Raw expansion does not
turn the source record into proof that an action succeeded.

## Inspect available sessions and workers

```js
return sessions({ project: 'PROJECT_SLUG_FROM_OVERVIEW', source: 'yachiyo', limit: 10 })
```

```js
return subagents({ sessionId: 'SESSION_ID', limit: 10 })
```

Do not infer a worker's complete history from a `delegateTask` summary. New
Yachiyo worker transcripts retain tool inputs, outputs, mailbox metadata,
compaction summaries, and terminal status. Old sessions may contain only the
delegation and final summary.
