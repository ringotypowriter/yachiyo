# Yachiyo

Yachiyo

## Docs

- `docs/yachiyo-mvp-architecture.md` - product direction, runtime architecture, package choices, and MVP scope

## Recommended IDE Setup

- [VSCode](https://code.visualstudio.com/) + [ESLint](https://marketplace.visualstudio.com/items?itemName=dbaeumer.vscode-eslint) + [Prettier](https://marketplace.visualstudio.com/items?itemName=esbenp.prettier-vscode)

## Project Setup

### Runtime

```bash
$ nvm use
```

This project is pinned to Node `22.22.1` via `.nvmrc` and `.node-version`.
Electron `39.8.2` embeds Node `22.22.1`, and its native module ABI is `140`.
Your shell `node -v` will show `22.22.1`, but `process.versions.modules` becomes `140` only inside Electron.

### Install

```bash
$ pnpm install
```

Install no longer forces an Electron native rebuild. Ordinary Node-side tests avoid loading `better-sqlite3`, so they can run without touching native sqlite artifacts.

If a native module mismatch appears, or before running Electron/native sqlite paths, rebuild Electron native dependencies explicitly:

```bash
$ pnpm run native:rebuild
```

This command verifies `better-sqlite3` inside Electron itself, then falls back to a forced Electron-target rebuild if a normal rebuild still leaves the wrong ABI in place.

### Development

```bash
$ pnpm dev
```

`pnpm dev` and `pnpm start` still rebuild Electron native dependencies first, so the app keeps using sqlite through the Electron ABI path.

### Tests

Ordinary server tests run against the in-memory storage adapter and do not load `better-sqlite3`:

```bash
$ pnpm run test:server
```

Native sqlite integration tests are opt-in and run through Electron's Node runtime after an explicit rebuild:

```bash
$ pnpm run test:server:native
```

### Build

```bash
# For windows
$ pnpm build:win

# For macOS
$ pnpm build:mac

# For Linux
$ pnpm build:linux
```
