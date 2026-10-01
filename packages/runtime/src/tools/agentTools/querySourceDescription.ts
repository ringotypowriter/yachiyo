export function buildDescription(input: { activityOcrEnabled: boolean }): string {
  const activitySourceEventsDescription = input.activityOcrEnabled
    ? `  Includes conversation activity and foreground app/window activity records. Activity rows can include window text snapshots when present. Does not include memories.`
    : `  Includes conversation activity and foreground app/window activity records. Does not include memories.`

  const activityRecordsDescription = input.activityOcrEnabled
    ? `  Durable foreground app/window activity records. Rows include app names, bundle IDs, window titles, and window text snapshots when present.\n  Use this to inspect what the user was doing during a time range, search activity summaries, or search text visible in active windows.`
    : `  Durable foreground app/window activity records. Rows include app names, bundle IDs, and window titles.\n  Use this to inspect what the user was doing during a time range or search activity summaries.`

  return `
Query read-only local context sources saved by Yachiyo.

For everyday recall, provide text to find past discussions, or ref to open a returned source reference.
Search results separate notes from original excerpts. Notes are recollection aids, not verified facts.
Use original dialogue for exact quotes, historical decisions, or claims about completed actions.
Opening a reference returns messages with their speakers and timestamps. Use nextCursor with the same ref to continue reading; boundary message refs let you expand surrounding dialogue.
Use text with from to search one table, or with where to narrow a search. Without from or filters, text searches conversations and notes together. Use ref alone (optionally with limit/cursor) to open dialogue.

The sources are exposed as virtual tables. This tool does not execute raw SQL.
Use \`from\` to choose one table, \`where\` to filter rows, and \`view\` to choose the table-specific depth.
\`limit\` and \`cursor\` paginate the returned top-level rows.
Rows may include a \`rowId\` for exact follow-up queries on tables that support row opening.

Terminology:

- A thread is the internal data name for one user-visible conversation.
- Use thread table names, threadId, and thread rowIds when querying this tool.
- When answering the user, say "conversation" instead of "thread" unless you are quoting a table name, field name, rowId, or the user used "thread" first.

View Contract:

- index queries the selected table's index view.
- content queries the selected table's content view.
- detail queries the selected table's detail view.
- Each table maps these views to concrete row tables below.

Table Map:

- source_events
  A timeline view over event-like sources. Use this when you need to know what happened during a time range.
  index: source_events timeline rows.
  content: source row for the event, such as thread_spans or activity_records.
  detail: concrete detail rows for the source, such as thread_messages for a conversation span or activity_records detail rows.
${activitySourceEventsDescription}

- memories
  Revisable notes linked to past conversations, including older structured memory entries.
  index/content/detail: memories rows ranked by text match.
  Rows can include sourceThreadRowIds and sourceMessageRowIds that can be opened through thread tables.
  Requires text; where.topic narrows the search.

- thread_folders
  User-curated thread communities. Threads in the same folder usually share a goal, project, or problem area.
  index: thread_folders rows.
  content: threads rows in the folder.
  detail: thread_spans rows in the folder.

- threads
  Thread-level rows. Each row includes folder/community metadata when available.
  index: threads rows.
  content: thread_spans rows for the thread.
  detail: thread_messages rows for the thread.

- thread_spans
  Searchable or time-bounded thread segments.
  index/content: span locator rows with metadata, summary, and matchedEvidence.
  detail with where.rowId: thread_messages rows for the span.
  Prefer this table when starting from a vague question about prior discussions.

- thread_messages
  Actual messages from threads.
  index/content/detail: thread_messages rows.
  where.parentRowId accepts a thread rowId or span rowId.
  Use this after finding a thread span, or when you already know a threadId, rowId, or parentRowId.

- activity_records
${activityRecordsDescription}
  index: activity_records summary rows.
  content: activity_records rows with entries and window text snapshot snippets when enabled.
  detail: activity_records rows with entries and full window text snapshots when enabled.

Time Filters:

- where.since and where.until must be ISO 8601 timestamps, not natural-language times.
- Prefer UTC timestamps ending in Z. Local clock times are valid only when they include an explicit offset, such as +08:00.
- Examples: {"since":"2026-05-17T04:00:00.000Z","until":"2026-05-17T09:07:00.000Z"} or {"since":"2026-05-17T12:00:00+08:00","until":"2026-05-17T17:07:00+08:00"}.

Ordering:

- auto
  Default. Chooses the natural order for the table: match order for memories and text-filtered thread_spans, newest-first time order for timeline and browsing tables, and chronological order for thread_messages.

- match
  Match-ranked search order. Only supported for memories and thread_spans with text. Do not use this for source_events, activity_records, threads, thread_folders, or thread_messages because they do not have one unified match score.

- timeAsc / timeDesc
  Explicit chronological order. Not supported for memories because memory rows are match-ranked facts, not timeline events.

Rules:

- Start with index unless you already know the exact row to open.
- Use the narrowest useful filters.
- Do not use memories for timeline browsing.
- Use thread_spans to discover past discussions, then use thread_messages to read dialogue.
- Use exact rowId, threadId, folderId, or parentRowId before content/detail when available.
- Same-folder threads are a strong community signal, but they are not expanded unless you query by folderId or follow an available folder view.
`
}
