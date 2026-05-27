# Vibe Wiki: Explaining a Codebase

The leader hands you a repo and asks "what is this?" or "how does X work?" Your job: build them an accurate mental model, fast. Not a file tour, not a directory dump — a model.

## What "Explaining a Codebase" Actually Means

A good explanation answers, in this order:

1. **What does this thing do?** (one sentence)
2. **Who is it for?** (one sentence)
3. **What's the shape?** (the 3-5 main pieces and how they connect)
4. **Where would I go to change X?** (entry points for the most likely tasks)
5. **What's weird or surprising?** (anything that would trip up a newcomer)

Not in this order:

- A folder-by-folder walkthrough.
- A list of every file.
- A breakdown of every dependency.
- A re-statement of what's already in the README.

## Sequence

1. **Read the README + manifest first.** `package.json`, `pyproject.toml`, `Cargo.toml`, `go.mod`, `Gemfile`, `pom.xml` — whichever the project uses. Often answers questions 1 and 2 outright.
2. **Find entry points.** `main.go`, `main.py`, `__main__.py`, `index.ts`, `app.rb`, `src/main.rs`, the `bin/` script, the `cmd/` directory. The codebase opens here.
3. **Trace one happy path end-to-end.** User does X → request goes through Y → handler Z → response. One concrete trace beats a thousand abstract diagrams.
4. **Note the seams.** Where do modules talk to each other? What's the contract at each boundary?
5. **Identify the load-bearing files.** The 5-10 files where the actual work happens. Most repos are 80% scaffolding and 20% logic.

## Shape vs Detail

The leader rarely needs a tour. They need a **shape** — enough to know where to look next.

Bad ("tour"):

> The `src/` directory contains the source code. Inside, there's a `models/` folder with the data models, a `views/` folder with the UI, a `controllers/` folder with the controllers, a `utils/` folder with helpers…

Good ("shape"):

> It's a backend service for an internal admin panel. Three layers: HTTP handlers in `api/` call domain services in `core/`, which talk to Postgres via the repository layer in `storage/`. Background jobs run as a separate worker process under `worker/`, sharing the same `core/` services but triggered by a Redis queue.

The second one builds a model. The first one inventories files.

## Use Concrete Examples

When explaining how something works, trace one real path. Two examples in different stacks:

**A web upload flow (Python/FastAPI):**

> When a user uploads a file:
>
> 1. The client POSTs to `/api/upload` (`app/api/routes/upload.py:24`).
> 2. The handler validates with a Pydantic model (`app/schemas/upload.py:12`), then calls `UploadService.store()` (`app/services/upload.py:38`).
> 3. The service writes to S3 and inserts a row into `files` via SQLAlchemy (`app/models/file.py:15`).
> 4. The handler returns the file ID; the client navigates to `/files/{id}`.

**A CLI command (Go):**

> When the user runs `mycli sync`:
>
> 1. Cobra dispatches to `runSync` (`cmd/sync.go:32`).
> 2. It loads config from `~/.mycli/config.yaml` via `config.Load()` (`internal/config/config.go:18`).
> 3. It opens a connection in `internal/api/client.go:45` and calls `client.FetchAll()`.
> 4. Results are diffed against local state and persisted via `internal/store/sqlite.go:67`.

Concrete > abstract. Line numbers > "somewhere in the upload handler."

## Surface the Surprising

Every codebase has things that aren't obvious from reading top-down. Call them out:

- **Non-obvious conventions.** "All files prefixed with `_` are internal and excluded from the public API."
- **Hidden coupling.** "Changing the schema requires running the migration generator AND restarting the dev server, otherwise the type stubs are stale."
- **Counterintuitive design.** "It looks like a monolith but the `worker/` directory runs as a separate process."
- **Historical baggage.** "There are two HTTP clients because the migration from the old library to the new one is half-done."
- **Sharp edges.** "The cache is per-process — it'll behave differently in dev vs prod where there are multiple workers."

These are the things experienced contributors know that newcomers learn the hard way. Surface them.

## Tools to Build Understanding Fast

- `git log --oneline -20` — recent activity tells you what's hot.
- `git log --stat -- path/to/dir` — what's changed in this area lately.
- `git blame` — who wrote this and when (context for asking them).
- `grep` for entry-point keywords (`main`, `if __name__`, `app.listen`, `createServer`, `mount`, `Router`, `cobra.Command`).
- Read the test files for the module — tests describe expected behavior in isolation.
- Look at the project's task runner (`package.json` scripts, `Makefile`, `justfile`, `pyproject.toml` `[tool.poetry.scripts]`, `Rakefile`) — it often reveals the dev/build/deploy story.

## What Not to Do

- **Don't summarize what's already in the README.** The leader can read.
- **Don't list every file.** It's noise.
- **Don't explain language/framework basics.** "React is a UI library…" / "Django is a web framework…" — assume competence.
- **Don't speculate without saying so.** If you're guessing how something works, say "I think" — the leader can verify or correct.
- **Don't editorialize without value.** "This codebase has some interesting choices" tells the reader nothing.

## Honesty About Limits

If you've only read part of the codebase, say so. If a section is unclear and you're guessing, say so. If you suspect there's a piece you haven't found yet, say so.

> Quick read of the main flow — I haven't dug into `workers/` yet, but it looks like a separate process the API talks to via Redis. If you need that part explained, point me at it.

This is far more useful than confident wrongness.

## Format

For verbal explanations: 3-5 short paragraphs, possibly a small diagram in ASCII or words.

For written explanations (e.g. an `ARCHITECTURE.md`): the same structure as the questions above, with file path references and one concrete trace per major flow.

Either way: build a model, point to the load-bearing files, name the surprises. Stop.
