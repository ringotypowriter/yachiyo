# Greenfield: Starting from Zero

The temptation is to set up everything. Resist it. The job of day one is to prove the wiring, not to build the city.

## Sequence

1. **Walking skeleton first.** End-to-end thinnest slice that runs: one route, one render, one round-trip. Prove the wiring before adding features.
2. **README before code.** One paragraph: what this is, who it's for, how to run. If you can't write that paragraph, you don't know what you're building yet.
3. **Pick the smallest scaffolding that works.** A static site generator beats a full SSR framework if you don't need SSR. SQLite beats Postgres until you outgrow it. No auth/billing/i18n until a real user needs it.
4. **Lock the toolchain on day one.** Lockfile committed, language/runtime version pinned (`.nvmrc`, `.tool-versions`, `.python-version`, `go.mod`, `rust-toolchain.toml`), formatter + linter configured. Adding these later is painful.
5. **One file per concern is fine.** Don't pre-split into 12 modules. A 200-line single-file app is fine until it isn't.

## Defaults to defer

These almost always show up in scaffolding tutorials and almost never need to exist on day one:

- Auth system → use a hardcoded user
- Real database → in-memory or JSON file
- CI/CD pipelines → run tests locally first
- Containerization → run on host until deployment matters
- Monorepo tooling → one package until you genuinely need two
- State management library → start with built-in language/framework primitives
- ORM → raw SQL or a query builder is often enough at first
- Logging framework → printing to stdout is a logging framework

## Defaults to set immediately

These are cheap now and expensive later:

- `.gitignore` (don't commit build artifacts or dependency caches even once: `node_modules/`, `__pycache__/`, `target/`, `dist/`)
- Formatter on save (Prettier, Biome, `gofmt`, `ruff format`, `rustfmt`, `black`)
- One smoke test that proves the build works
- License file
- Minimal README with run instructions
- `.env.example` if any secrets exist

## Naming and Layout

Pick a directory layout you can defend in one sentence. `src/` for code, `tests/` adjacent or colocated — pick one and stick with it. Refactoring layout later is mechanical; choosing inconsistently is corrosive.

Common defensible layouts:

- **Flat**: everything in `src/`, split when files start clustering by topic.
- **Feature-based**: `src/features/<feature>/` — each feature owns its components, hooks, tests, types.
- **Layer-based**: `src/{routes,services,db,ui}/` — works well for small backends, fights you in larger frontends.

Whichever you pick, write one sentence in the README explaining why. Future contributors (including future-you) will know where to put new code.

## Dependency Discipline

Every dependency is a future maintenance cost. Before adding one, check:

- Does the language/framework already do this?
- Is this dependency actively maintained (commits in the last 6 months)?
- Does it have a license you can ship under?
- Is the install size reasonable?

A small project with 3 carefully chosen deps ages better than one with 30 transitive blobs.

## Common Mistakes

- **Premature framework selection.** "We might need GraphQL / microservices / Kubernetes" → you don't, until you do.
- **Over-engineered build pipeline.** A 12-plugin bundler config on day one for a static site.
- **Setting up tests with no code to test.** Write the first feature, then test it.
- **Designing the database schema before knowing the queries.** Schema follows access patterns, not the other way around.
- **Inventing config for hypothetical environments.** One `.env` is enough until staging actually exists.

## When to Stop Setting Up and Start Building

When you have:

1. A repo that runs (the dev / run command works end-to-end).
2. A README that explains the goal.
3. A way to run tests, even if there are none yet.
4. Source control with the first commit.

Stop. Write the first real feature. Everything else can wait until it earns its place.
