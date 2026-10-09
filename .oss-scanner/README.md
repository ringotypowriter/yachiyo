# OSS Scanner preparation

This directory prepares Yachiyo for [Anthropic OSS Scanner](https://github.com/anthropics/oss-scanner).
It does not enroll the project, contact Anthropic, run Claude Code, or publish a report address.

## Build online, test offline

Use a **clean checkout of the commit being audited** on a disposable Linux x86-64 cloud
runner with Docker. Do not use a working directory containing credentials or user data.
The Dockerfile-specific ignore file excludes common machine state, but is not a secret scanner.
Do not mount a host home directory, Docker socket, credentials, or Yachiyo profile into the image.

```sh
docker build --platform linux/amd64 --progress plain \
  -f .oss-scanner/Dockerfile -t yachiyo-oss-scanner .
docker run --rm --init --network none \
  yachiyo-oss-scanner bash .oss-scanner/test-offline.sh
```

The image keeps the checkout at `/src`, with Node 22.22.1, pnpm 10.30.3 and Rust 1.99.0.
Its online build installs locked workspace dependencies, downloads Electron and bundled `rg`/`fd`,
prepares Electron-ABI native modules, builds `sync-core`/`process-host` and the desktop bundles,
and retains the Cargo registries, build artifacts and test dependencies. Native compilation
happens only inside the disposable image; it does not rebuild the host checkout's dependencies.
The image is an audit/development environment, not a distributable desktop release.

The offline script fails on any failed suite and runs:

- `pnpm run test:server`
- `node scripts/run-server-tests.mjs apps/desktop/src/main` (includes `test:remote` coverage)
- `pnpm run test:renderer`
- `pnpm run test:server:native`
- `cargo test --locked --offline` for both Rust crates

`test:server:native` uses Electron's Node runtime, rather than the host Node ABI. It calls the
normal preparation scripts again: the prepared image must already contain everything they need.
The package-manager offline flags are only defense in depth; Docker's `--network none` is the
actual network isolation. Loopback remains available to tests inside the container.

The `OSS Scanner environment` GitHub Actions workflow builds the image and runs the same command
with no network or host mounts. It is scoped to scanner preparation and its build/toolchain inputs, and can also be run
manually. A green normal CI job alone does not prove that this image works offline.

For a shell in the prepared environment:

```sh
docker run --rm --init -it --network none yachiyo-oss-scanner bash
```

## Coverage limits

The automated check covers fixture-backed server, desktop main-process/Remote, renderer and native tests. It does not
claim to exercise a real paired phone, live providers, real Telegram/Discord accounts, browser GUI
smoke tests, signed installers, macOS Keychain/iCloud integrations, or iOS device behavior.

Full Linux Remote pairing needs a session D-Bus and an **unlocked Secret Service keyring** for
Electron `safeStorage`. The image includes the related packages, but does not create a keyring,
save credentials, or weaken Remote authentication. Plaintext/basic credential fallback disables
Remote and must not be used to claim secure pairing coverage. If exploring this path, use only an
isolated temporary profile and disposable test credentials; no production account is needed for
the default test script. See [the threat model](threat_model.md) for source paths and boundaries.

## Separate enrollment decision

Before a future enrollment PR, the maintainer must choose a report email address they accept being
public and review/accept the applicable [OSS Scanner terms](https://red.anthropic.com/oss-scanner/terms).
A future `projects/yachiyo/project.yaml` in Anthropic's repository would refer to:

```yaml
repo: https://github.com/ringotypowriter/yachiyo
dockerfile: .oss-scanner/Dockerfile
threat_model: .oss-scanner/threat_model.md
# primary_contact must be explicitly chosen before enrollment.
```

After that decision, follow the current upstream template and validation instructions. Upstream
`tools/check` adds the scanner/Claude Code layer and has its own terms; this preparation workflow
only validates Yachiyo's image and tests and does not run that tool or initiate a security scan.
