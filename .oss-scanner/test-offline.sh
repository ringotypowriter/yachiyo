#!/usr/bin/env bash
set -euo pipefail
cd /src

# The caller must supply --network none (see README). Use only temporary state.
export CARGO_NET_OFFLINE=true
export npm_config_offline=true
export YACHIYO_HOME
YACHIYO_HOME="$(mktemp -d /tmp/yachiyo-scanner-test.XXXXXX)"
trap 'rm -rf "$YACHIYO_HOME"' EXIT

pnpm run test:server
# Includes Remote plus main-process protocol, credential and file-boundary tests.
node scripts/run-server-tests.mjs apps/desktop/src/main
pnpm run test:renderer
# Reuses Electron-ABI addons and the Cargo artifacts prepared during the build.
# No database migration, real provider, channel account or Remote pairing needed.
pnpm run test:server:native
cargo test --locked --offline --manifest-path native/sync-core/Cargo.toml
cargo test --locked --offline --manifest-path native/process-host/Cargo.toml
