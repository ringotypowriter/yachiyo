# Project Iteration

Adding features or making changes inside a codebase that already has users, history, and habits. The codebase has a personality — match it.

## Sequence

1. **Read before you write.** Open the file you'll change and at least its 2-3 most important callers. Notice the conventions.
2. **Find the right seam.** New behavior usually belongs near existing similar behavior, not in a new top-level module.
3. **Plan the diff in your head.** What files? What types? What tests? If the answer involves >5 files, surface a plan to the leader before editing.
4. **One concern per commit.** Feature, refactor, format change → separate commits.
5. **Update tests in the same commit as the code.** A green CI lies if the tests didn't move with the code.

## Read the Codebase First

Before adding a feature, answer:

- **Where does similar behavior live today?** Mirror it.
- **What's the project's error-handling pattern?** Throws? Result types? Callbacks with err first? Match it.
- **What's the testing convention?** Filename pattern, test runner, mocking style.
- **What's the import / module style?** Default vs named exports, barrel files, package layout, internal vs public modules?
- **What naming conventions are in play?** `camelCase` vs `snake_case` vs `PascalCase`, framework-specific prefixes (`useFoo`, `*Service`, `*Repository`, `*Handler`), filename casing.

When in doubt, grep for the closest neighbor and copy its shape.

## Match Style, Don't Reform It

If the codebase uses tabs, you use tabs. If it uses single quotes with no semicolons, so do you. If it puts types in a separate `types.ts` file, do that.

A bug fix or feature is not the moment to relitigate style decisions. Open a separate, isolated PR if you genuinely think the convention is wrong — and expect pushback.

## Scope Discipline

The cardinal sin of iteration: scope creep.

- A feature task adds the feature. Not the feature plus a refactor of the surrounding module.
- "While I'm here" cleanups should be a separate commit at minimum, ideally a separate PR.
- If you find a real bug while doing your task, note it and decide: fix in a separate commit, or file an issue. Don't silently bundle.

When you bundle, reviewers can't tell the feature from the cleanup, and the blast radius of any single problem doubles.

## Adding to Existing Abstractions

When extending an existing system:

1. Use the same abstraction layer the existing code uses. Don't reach past it.
2. If the abstraction doesn't fit your use case, ask: is your use case wrong, or is the abstraction wrong? Both are possible.
3. Don't add a parallel system. If the codebase has one HTTP client, don't add a second.
4. If you must extend the abstraction, do it in a way that doesn't break existing callers.

## Touching Cross-Cutting Concerns

Auth, logging, error handling, telemetry, feature flags — these touch everything. Be extra careful:

- A change to the logger affects every log line.
- A change to the auth middleware affects every request.
- A change to the error handler affects every failure path.

For these, the read-before-write ratio should be 10:1, not 2:1.

## Migrations and Schema Changes

If the project uses an ORM or migration tool, **never hand-write migration files**. Edit the schema source, then run the official generator (`alembic revision --autogenerate`, `prisma migrate dev`, `drizzle-kit generate`, `rails db:migrate`, `sqlx migrate add`, `goose create`, etc.).

Hand-written migrations:

- Drift from the schema source over time.
- Get out of sync with the ORM's internal state tracking.
- Can be silently wrong in ways the generator catches.

Exception: when the generator genuinely can't express the change (some database-specific constructs, certain index types, complex data backfills). Document the exception in the migration file.

## Dependency Changes

- Don't add a dependency for something already covered.
- Don't bump major versions as a side effect of unrelated work.
- If you must add one, run the install yourself and verify the lockfile change is sane.
- Don't pull in a heavyweight library just to use one helper function.

## Anti-Patterns

- **Drive-by refactor.** "I noticed this could be cleaner" — file an issue, don't bundle.
- **Hidden behavior change.** A "refactor" PR that subtly changes what the code does.
- **Silent format change.** Reformatting a file you also modified — the diff becomes unreviewable.
- **New convention introduced once.** If you do something the codebase has never done, expect to defend it.
- **Bypassing established abstractions** because they're "annoying." If they're annoying for everyone, fix them; if just for you, conform.
