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

- Add explicit return types to exported functions. Do not rely on inference for public helpers, tool factories, or other exported module APIs.

## UI Hierarchy & Settings Design Rules

- All UI must stay within 4 information layers maximum. If a screen reads like realm -> section -> subsection -> card -> item -> helper text, it is already too deep.
- Settings pages must be flatter than normal product surfaces. A single settings panel may contain only:
  - 1 large realm/category label
  - the concrete setting item(s)
    This means a maximum of 2 layers inside one panel.
- Do not restate the same meaning across realm label, title, subtitle, item label, helper text, and pill. If two adjacent lines communicate the same thing, delete one.
- Do not use decorative pills/chips as a substitute for hierarchy. Chips are allowed only for real state, status, or compact metadata; never for repeating explanatory copy.
- Choose controls by semantics, not by appearance:
  - Use `switch` for true on/off preferences.
  - Use a compact mode toggle only for small binary mode switches.
  - Use radio choices only when explicit comparison between multiple mutually exclusive options is necessary.
  - Use dropdowns/selectors for “choose one from many”, including “disabled” as one option when appropriate.
- If the app already has a canonical control for a meaningfully identical interaction, reuse or adapt that control instead of inventing a second settings-only version. For dropdowns/selectors, always use `SimpleSelect` from `primitives.tsx` — never raw `<select>` elements.
- For model selection UX, do not dump every known model into the picker. Show only explicitly enabled/selectable models unless the product requirement says otherwise.
- For overlays inside settings or other scrollable panels, do not leave popups trapped in local stacking/scroll contexts. Use proper floating-layer behavior so the selector reads as an overlay, not as content embedded inside the page.
- Default toward fewer words. Prefer label + short consequence over label + explanation + repeated explanation.
- A setting row should usually answer only two questions:
  - What does this control change?
  - What happens when it is on or off?
    Anything beyond that should be justified, not automatic.

## Testing Guidelines

This repo uses `node:test`. Keep tests next to the code they verify using `*.test.ts`; reserve `*.native.test.ts` for Electron/sqlite coverage only. Default tests should prefer in-memory storage so they stay fast and do not depend on native modules. Add or update tests for new CLI commands, storage behavior, protocol changes, and state transformation helpers.

## Icon Usage

- **Never hand-draw SVG icons.** Always use Lucide React (`lucide-react`) for icons first. Only fall back to inline SVG if the required icon genuinely does not exist in Lucide.

## Tool Defaults

- Newly added agent tools must be enabled by default unless the product requirement explicitly says otherwise.

## Commit & Pull Request Guidelines

Recent history follows Conventional Commits: `feat:`, `fix:`, `refactor:`, `chore:`. Keep subjects short and imperative, for example `feat: add reply branching`. PRs should describe the user-visible change, call out any schema or native dependency impact, link the relevant docs or issue, and include screenshots for renderer or settings-window UI work.

## Security & Configuration Tips

Do not commit provider secrets, local sqlite files, or machine-specific data. Runtime settings live under `~/.yachiyo` by default; override with `YACHIYO_HOME` when you need an isolated workspace. Use Drizzle tooling for migrations instead of hand-editing generated SQL unless there is a documented exception.

## Configuration Extension Notes

- Treat `src/shared/yachiyo/protocol.ts` as the runtime contract only. Keep TOML keys, legacy migrations, and file-format quirks out of that file.
- `src/main/yachiyo-server/settings/settingsDefaults.ts` owns the default in-memory settings shape. Keep new defaults there instead of scattering them across readers or writers.
- `src/main/yachiyo-server/settings/settingsConfig.ts` should stay as a small assembly facade. Put feature-specific normalization in the neighboring normalization modules instead of growing that file again.
- `config.toml` now flows through `src/main/yachiyo-server/settings/settingsTomlCodec.ts` and `src/main/yachiyo-server/settings/settingsTomlSlices.ts`.
- Settings normalization is split by concern:
  - `settingsFeatureNormalization.ts` for general/chat/workspace/memory/web-search style sections
  - `settingsProviderNormalization.ts` for providers, tool-model resolution, and runtime provider snapshots
  - `settingsProfileNormalization.ts` for subagents and essentials
- `channels.toml` now flows through `src/main/yachiyo-server/runtime/channelsTomlCodec.ts` and `src/main/yachiyo-server/runtime/channelsTomlSlices.ts`.
- Keep the public entry points stable: `src/main/yachiyo-server/settings/settingsStore.ts` and `src/main/yachiyo-server/runtime/channelsConfig.ts` should stay thin read/write facades.
- When adding a new setting, update the runtime type in `protocol.ts`, add the default in `settingsDefaults.ts` if needed, add one slice entry for reading and writing the TOML field, and extend the owning normalization module instead of touching unrelated slices.
- Put legacy compatibility fixes in the codec layer, not in feature code. For `config.toml`, keep old-format rewrites near `fixLegacyJsonEnv`.
- Preserve deterministic TOML output order by appending new slice entries in the intended section order instead of inserting ad hoc writes elsewhere.
- Add or update round-trip tests beside the owning config module. Every new field should be covered by parse -> normalize -> stringify -> parse behavior.

## ORM Migration Rule

- In projects that use an ORM or schema tool, handwritten migration files are prohibited by default.
- Update the schema source first, then generate migrations with the project's official CLI or generator.
- If a handwritten migration is added by mistake, remove it and regenerate the migration from schema changes.
- Only write a migration by hand when the user explicitly asks for it and the generator cannot express the required change.
