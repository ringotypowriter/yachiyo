# Build with the repository root as context. The scanner audits /src offline.
FROM rust:1.99.0-bookworm AS rust
FROM node:22.22.1-bookworm

ENV DEBIAN_FRONTEND=noninteractive \
    HUSKY=0 \
    CI=true \
    CARGO_HOME=/usr/local/cargo \
    RUSTUP_HOME=/usr/local/rustup \
    PATH=/usr/local/cargo/bin:$PATH \
    CFLAGS="-g -fno-omit-frame-pointer" \
    CXXFLAGS="-g -fno-omit-frame-pointer" \
    RUSTFLAGS="-C debuginfo=2 -C force-frame-pointers=yes"

# Keep the compiler and Cargo cache available for offline reproducer builds.
COPY --from=rust /usr/local/cargo /usr/local/cargo
COPY --from=rust /usr/local/rustup /usr/local/rustup
RUN apt-get update && apt-get install -y --no-install-recommends \
      build-essential clang cmake ninja-build pkg-config git python3 \
      ca-certificates curl unzip \
      libasound2 libatk-bridge2.0-0 libatk1.0-0 libcups2 libdbus-1-3 \
      libdrm2 libgbm1 libgtk-3-0 libnspr4 libnss3 libsecret-1-0 \
      libxcomposite1 libxdamage1 libxfixes3 libxkbcommon0 libxrandr2 \
      dbus-x11 gnome-keyring xvfb xauth \
    && rm -rf /var/lib/apt/lists/* \
    && npm install --global pnpm@10.30.3

# Debian's login profile replaces PATH, hiding Cargo and temporary CLI fixtures
# injected by tests. Preserve the caller's PATH in this audit-only image.
RUN sed -i '1i _YACHIYO_SCANNER_INHERITED_PATH=$PATH' /etc/profile \
    && printf '\nexport PATH="$_YACHIYO_SCANNER_INHERITED_PATH"\nunset _YACHIYO_SCANNER_INHERITED_PATH\n' >> /etc/profile

# Scanner contract: include the source and all test fixtures at /src.
COPY . /src
WORKDIR /src

# Every dependency download happens online, including Electron, native addon
# headers, bundled rg/fd, Rust crates and test-only crates. Do not prune caches.
RUN test "$(node -p process.arch)" = x64 \
    && test "$(node --version)" = "v$(cat .node-version)" \
    && test "pnpm@$(pnpm --version)" = "$(node -p 'require("./package.json").packageManager')" \
    && pnpm install --frozen-lockfile \
    && node --experimental-strip-types --test packages/runtime/src/channels/group/groupProbeClaudeCode.test.ts \
    && cargo fetch --locked --manifest-path native/sync-core/Cargo.toml \
    && cargo fetch --locked --manifest-path native/process-host/Cargo.toml \
    && pnpm build \
    && cargo test --locked --no-run --manifest-path native/sync-core/Cargo.toml \
    && cargo test --locked --no-run --manifest-path native/process-host/Cargo.toml

# Fail on a missing staged helper rather than silently testing a reduced image.
RUN test -f apps/desktop/out/main/index.js \
    && apps/desktop/resources/bin/linux-x64/rg --version \
    && apps/desktop/resources/bin/linux-x64/fd --version \
    && test -x apps/desktop/resources/bin/linux-x64/sync-core \
    && test -x apps/desktop/resources/bin/linux-x64/process-host \
    && pnpm native:prepare

# These flags prevent package managers trying the network; --network none is
# still required for real isolation. No host credentials or profiles are used.
ENV CARGO_NET_OFFLINE=true \
    npm_config_offline=true \
    YACHIYO_HOME=/tmp/yachiyo-scanner-home
CMD ["bash"]
