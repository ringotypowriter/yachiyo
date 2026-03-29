# Zotero Local HTTP Server API Reference

Base URL: `http://127.0.0.1:23119`

Port is configurable via the `httpServer.port` preference in Zotero. Default: **23119**.

## Authentication

None required for programmatic access (curl, fetch, etc.). Browser-based requests are blocked unless they carry `X-Zotero-Connector-API-Version` header.

---

## 1. Local REST API (`/api/...`)

Mirrors the Zotero Web API v3 URL structure. **Read-only.** Use `userID=0` as shorthand for the local user.

### Metadata

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/` | Version headers, placeholder text |
| GET | `/api/schema` | Global schema JSON |
| GET | `/api/itemTypes` | All item types with localized names |
| GET | `/api/itemFields` | All fields with localized names |
| GET | `/api/itemTypeFields?itemType=X` | Fields for a specific item type |
| GET | `/api/itemTypeCreatorTypes?itemType=X` | Creator types for a specific item type |
| GET | `/api/creatorFields` | firstName, lastName, name |

### Items

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/users/:uid/items` | All items |
| GET | `/api/users/:uid/items/top` | Top-level items only |
| GET | `/api/users/:uid/items/trash` | Trashed items |
| GET | `/api/users/:uid/items/:key` | Single item |
| GET | `/api/users/:uid/items/:key/children` | Child items (notes, attachments) |
| GET | `/api/users/:uid/items/:key/file` | 302 redirect to local file |
| GET | `/api/users/:uid/items/:key/file/view/url` | File URL as text |
| GET | `/api/users/:uid/items/:key/fulltext` | Full-text content + stats |
| GET | `/api/users/:uid/items/tags` | Tags from items |

### Collections

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/users/:uid/collections` | All collections |
| GET | `/api/users/:uid/collections/top` | Top-level collections |
| GET | `/api/users/:uid/collections/:key` | Single collection |
| GET | `/api/users/:uid/collections/:key/collections` | Child collections |
| GET | `/api/users/:uid/collections/:key/items` | Items in collection |
| GET | `/api/users/:uid/collections/:key/items/top` | Top-level items in collection |

### Searches

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/users/:uid/searches` | All saved searches |
| GET | `/api/users/:uid/searches/:key` | Single saved search |
| GET | `/api/users/:uid/searches/:key/items` | Execute saved search (live) |

### Tags

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/users/:uid/tags` | All tags |
| GET | `/api/users/:uid/tags/:tag` | Single tag |

### Groups

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/users/:uid/groups` | User's groups |
| GET | `/api/groups/:gid` | Single group |
| GET | `/api/groups/:gid/items` | Group items (same item sub-paths apply) |
| GET | `/api/groups/:gid/collections` | Group collections |

### Query Parameters

| Parameter | Values | Purpose |
|-----------|--------|---------|
| `format` | `json`, `keys`, `versions`, `bib`, `bibtex`, `biblatex`, `ris`, `csljson`, `csv` | Output format |
| `include` | `data`, `bib`, `citation`, or export format names | Additional data in response |
| `sort` | `dateAdded`, `dateModified`, `title`, `creator`, `itemType`, `date`, `publisher` | Sort field |
| `direction` | `asc`, `desc` | Sort direction |
| `start` | integer | Pagination offset |
| `limit` | integer | Results per page |
| `since` | version number | Items modified after this version |
| `q` | string | Quick-search query |
| `qmode` | `titleCreatorYear` | Search mode |
| `itemType` | type name(s), `-` prefix to exclude | Filter by type |
| `tag` | tag name(s), `-` prefix to exclude | Filter by tag |
| `itemKey` | comma-separated keys | Fetch specific items |
| `includeTrashed` | `1` | Include deleted items |
| `style` | CSL style ID | Citation style for bib output |
| `locale` | language code | Citation locale |

### Response Headers

| Header | Purpose |
|--------|---------|
| `Total-Results` | Total count before pagination |
| `Last-Modified-Version` | Library or item version |
| `Link` | Pagination links |

---

## 2. Connector Endpoints (`/connector/...`)

Used by the browser connector. Most useful for integration:

| Method | Path | Description |
|--------|------|-------------|
| GET/POST | `/connector/ping` | Health check |
| POST | `/connector/getSelectedCollection` | Current target collection/library |
| POST | `/connector/saveItems` | Save items from external source |
| POST | `/connector/import` | Import data |

---

## 3. Better BibTeX Endpoints (Plugin Required)

### CAYW — Cite As You Write

```
GET http://127.0.0.1:23119/better-bibtex/cayw?probe
```
Returns `"ready"` if BBT is available. Full picker (programmatic only):
```
GET http://127.0.0.1:23119/better-bibtex/cayw?format=biblatex&minimize=1
```

Formats: `latex`, `biblatex`, `pandoc`, `mmd`, `json`, `formatted-citation`, `formatted-bibliography`, `typst`, `scannable-cite`, `eta`.

### Pull Export

```
GET http://127.0.0.1:23119/better-bibtex/collection?[collectionPath].[format]
```

Formats: `biblatex`/`bib`, `bibtex`, `json`/`csljson`, `yaml`/`cslyaml`, `jzon`.
Optional: `&exportNotes=true`, `&useJournalAbbreviation=true`.

Example — export entire library as BibLaTeX:
```
GET http://127.0.0.1:23119/better-bibtex/collection?library.biblatex
```

### JSON-RPC 2.0

**URL:** `POST http://127.0.0.1:23119/better-bibtex/json-rpc`
**Content-Type:** `application/json`

Supports batch requests (send an array of request objects).

#### Methods

| Method | Parameters | Returns |
|--------|-----------|---------|
| `api.ready` | — | `{ zotero, betterbibtex }` versions |
| `user.groups` | `includeCollections?` | Array of `{ id, name, collections }` |
| `item.search` | `terms`, `library?` | Items with CSL JSON + citekey |
| `item.attachments` | `citekey`, `library?` | `[{ path, open, annotations }]` |
| `item.collections` | `citekeys[]`, `includeParents?` | Citekey → collection hierarchy |
| `item.notes` | `citekeys[]` | Citekey → notes |
| `item.bibliography` | `citekeys[]`, `format`, `library?` | Formatted bibliography string |
| `item.citationkey` | `item_keys[]` or `'selected'` | Item key → citation key |
| `item.export` | `citekeys[]`, `translator`, `libraryID?` | Exported string |
| `item.pandoc_filter` | `citekeys[]`, `asCSL`, `libraryID?`, `style`, `locale` | `{ errors, items }` |
| `collection.scanAUX` | `collection`, `aux` | `{ libraryID, key }` |
| `autoexport.add` | `collection`, `translator`, `path`, `displayOptions`, `replace` | `{ libraryID, key, id }` |

#### Example: Search

```json
{
  "jsonrpc": "2.0",
  "method": "item.search",
  "params": ["machine learning"],
  "id": 1
}
```

#### Example: Bibliography

```json
{
  "jsonrpc": "2.0",
  "method": "item.bibliography",
  "params": [
    ["citekey1", "citekey2"],
    { "id": "http://www.zotero.org/styles/apa" }
  ],
  "id": 1
}
```

#### Example: Export as BibLaTeX

```json
{
  "jsonrpc": "2.0",
  "method": "item.export",
  "params": [["citekey1"], "Better BibLaTeX"],
  "id": 1
}
```

#### Example: Check readiness

```json
{
  "jsonrpc": "2.0",
  "method": "api.ready",
  "params": [],
  "id": 1
}
```

---

## 4. Limitations

- Local REST API is **read-only** — no POST/PUT/DELETE for items.
- Only the currently logged-in user's data is accessible.
- Zotero must be open for the server to respond.
- BBT endpoints require the Better BibTeX plugin.
- Full-text depends on Zotero having indexed the PDF/attachment.
- No rate limiting on the local server.
