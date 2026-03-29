---
name: yachiyo-zotero
description: Query the local Zotero library via its HTTP server (port 23119) — search items, browse collections/tags, read notes and full-text content, export citations, and use Better BibTeX JSON-RPC when available. Use when the user mentions Zotero, citations, bibliography, reference library, or academic papers.
license: Original clean-room skill for Yachiyo. No third-party skill content included.
---

# Yachiyo Zotero

Use this skill when the user wants to interact with their local Zotero library.

Read [api.md](references/api.md) for the full endpoint reference before making non-trivial queries.

## Prerequisites

- Zotero 7 must be running locally (HTTP server on `127.0.0.1:23119`).
- No authentication is needed for programmatic (non-browser) access.
- Better BibTeX plugin is optional but enables citation-key search and richer export.

## Stable Workflow

1. Ping `http://127.0.0.1:23119/connector/ping` to confirm Zotero is running.
2. Use the local REST API (`/api/users/0/...`) for browsing items, collections, tags, and full text.
3. Use Better BibTeX JSON-RPC (`/better-bibtex/json-rpc`) when you need citation-key lookup or formatted bibliography.
4. Return structured results to the user — titles, authors, dates, keys, and links.

## Good Defaults

- Always use `userID=0` (shorthand for the local user) in REST paths.
- Prefer `format=json&include=data` for rich item metadata.
- Use `format=csljson` when the user needs standard citation data.
- Use `q=` for quick search; `tag=` and `itemType=` for filtering.
- Limit results with `limit=` when browsing large libraries.
- For citation export, prefer `format=bibtex` or `format=biblatex` on the REST API, or BBT pull export for citekey-aware output.

## Common Tasks

### Search items
```bash
curl -s "http://127.0.0.1:23119/api/users/0/items?q=QUERY&format=json&include=data&limit=20"
```

### Get a specific item
```bash
curl -s "http://127.0.0.1:23119/api/users/0/items/ITEMKEY"
```

### List collections
```bash
curl -s "http://127.0.0.1:23119/api/users/0/collections"
```

### Get items in a collection
```bash
curl -s "http://127.0.0.1:23119/api/users/0/collections/COLLKEY/items?format=json&include=data"
```

### Get notes and attachments for an item
```bash
curl -s "http://127.0.0.1:23119/api/users/0/items/ITEMKEY/children"
```

### Get full-text content
```bash
curl -s "http://127.0.0.1:23119/api/users/0/items/ITEMKEY/fulltext"
```

### Export citations as BibTeX
```bash
curl -s "http://127.0.0.1:23119/api/users/0/items?format=bibtex&itemKey=KEY1,KEY2"
```

### BBT: Search by terms (JSON-RPC)
```bash
curl -s -X POST http://127.0.0.1:23119/better-bibtex/json-rpc \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"item.search","params":["QUERY"],"id":1}'
```

### BBT: Get formatted bibliography
```bash
curl -s -X POST http://127.0.0.1:23119/better-bibtex/json-rpc \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"item.bibliography","params":[["citekey1","citekey2"],{"id":"http://www.zotero.org/styles/apa"}],"id":1}'
```

## Output Rules

- Present items with title, authors, date, and item type at minimum.
- Include the Zotero item key for follow-up queries.
- When exporting citations, use the format the user requested or default to BibTeX.
- For large result sets, summarize counts and show a representative sample.

## Limitations

- The local REST API is **read-only** — no creating, updating, or deleting items.
- Zotero must be open and running for the server to respond.
- Better BibTeX endpoints are only available if the plugin is installed.
- Full-text content depends on Zotero having indexed the attachment.
