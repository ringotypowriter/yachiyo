# Repository Guidelines

## Project Structure & Module Organization

`src/main` contains the Electron main process plus the local server in `src/main/yachiyo-server`. `src/preload` exposes the preload bridge. The React UI lives in `src/renderer/src`, with the separate settings window under `src/renderer/settings`. Shared protocol and message utilities belong in `src/shared/yachiyo`. Keep product and architecture notes in `docs/`, helper scripts in `scripts/`, and packaging assets in `build/` and `resources/`.

## Build, Test, and Development Commands

Use the pinned toolchain: `nvm use` and `pnpm install`.

- `pnpm dev`: rebuild native Electron deps, then start the app in development.
- `pnpm start`: preview the packaged Electron app locally.
- `pnpm run native:rebuild`: rebuild `better-sqlite3` for Electron after dependency or ABI changes.
- `pnpm run test:server`: run non-native server tests with Node’s test runner.
- `pnpm run test:server:native`: run sqlite integration tests through Electron.
- `pnpm run lint` and `pnpm run typecheck`: validate style and TypeScript before opening a PR.
- `pnpm run db:generate` / `pnpm run db:migrate`: manage Drizzle schema changes.

## Coding Style & Naming Conventions

Follow `.editorconfig` and Prettier: 2-space indentation, LF endings, single quotes, no semicolons, and `printWidth: 100`. Prefer small focused modules and feature-local code. Use `PascalCase` for React components (`MessageTimeline.tsx`), `camelCase` for utilities (`messagePrepare.ts`), and colocate shared types near the feature that owns them unless they cross process boundaries.

## Testing Guidelines

This repo uses `node:test`. Keep tests next to the code they verify using `*.test.ts`; reserve `*.native.test.ts` for Electron/sqlite coverage only. Default tests should prefer in-memory storage so they stay fast and do not depend on native modules. Add or update tests for new CLI commands, storage behavior, protocol changes, and state transformation helpers.

## Commit & Pull Request Guidelines

Recent history follows Conventional Commits: `feat:`, `fix:`, `refactor:`, `chore:`. Keep subjects short and imperative, for example `feat: add reply branching`. PRs should describe the user-visible change, call out any schema or native dependency impact, link the relevant docs or issue, and include screenshots for renderer or settings-window UI work.

## Security & Configuration Tips

Do not commit provider secrets, local sqlite files, or machine-specific data. Runtime settings live under `~/.yachiyo` by default; override with `YACHIYO_HOME` when you need an isolated workspace. Use Drizzle tooling for migrations instead of hand-editing generated SQL unless there is a documented exception.

## ORM Migration Rule

- In projects that use an ORM or schema tool, handwritten migration files are prohibited by default.
- Update the schema source first, then generate migrations with the project's official CLI or generator.
- If a handwritten migration is added by mistake, remove it and regenerate the migration from schema changes.
- Only write a migration by hand when the user explicitly asks for it and the generator cannot express the required change.
