# Bundled tunnel watchdog

Implemented in this skill's `scripts/` directory. Install it on every tunnel setup;
a bundled file or an alive cloudflared process is not proof that monitoring is running.

## Ownership and installation

`watchdog.mjs install` uses standalone Node.js and macOS utilities, with no npm install or app
restart. It copies the three runtime modules to `~/.yachiyo/helpers/tunnel-watchdog/`, records a
source hash and resolved Node executable, and registers `sh.ringo.yachiyo.tunnel-watchdog` under
`~/Library/LaunchAgents/`. `YACHIYO_HOME` overrides the helper's data/log root. The tunnel is
still the app-managed `sh.ringo.yachiyo.cloudflared` job.

There is one health loop: the helper, protected by BSD `shlock` and launchd's unique label. The
app's existing `TunnelSupervisor` remains responsible for hostname discovery and endpoint/iCloud
publication; it does not run another watchdog. Never add a cron job or another restart loop on
top. The helper validates the owned cloudflared plist before any recovery and uses only
`launchctl kickstart -k gui/<uid>/sh.ringo.yachiyo.cloudflared`. It does not reinstall the tunnel,
rewrite ingress, change protocol flags, touch other agents, revoke pairings, or create secrets.

Both tunnel modes select HTTP/2. HTTP/2 reduces dependence on QUIC/UDP but does
not prevent edge-registration failures. Named tunnels retain their routing configuration; the
probe supports the app-generated single-origin named ingress, not arbitrary user YAML.

## Health and recovery policy

Every 30 seconds, reread the managed plist and check the loopback origin WebSocket and loopback
cloudflared metrics. Require a valid `101` handshake and matching WebSocket accept header; a
plain HTTP 404 on the origin is not an origin health test. Missing/malformed/oversized metrics
remain unknown, never zero.

The public WebSocket probe uses bounded curl requests, respects normal transport/proxy behavior,
and validates the final upgrade rather than a proxy's `200 Connection established`. A timeout
after a valid 101 is expected for an idle socket, which is then closed. Public observations are
cached for at most five minutes while HA is nonzero; zero HA forces a fresh public probe. Quick
hostname discovery uses the latest `Requesting new quick Tunnel` log segment; a new segment
without a URL cannot reuse a previous launch's hostname. The URL banner can precede cloudflared's
`Starting tunnel` line.

Automatic restart requires all of the following:

- Startup/restart/wake grace has elapsed: 90 seconds. A scheduler gap over 90 seconds or a clock
  rollback resets grace and the failure streak.
- Three consecutive observations report zero HA connections and a healthy local origin.
- The current public response corroborates an unavailable tunnel (HTTP 530 or Cloudflare 1033),
  establishing that the edge is reachable. DNS/TLS timeouts with unknown network health do not
  count as proof of a tunnel failure.
- The restart cooldown and rolling attempt budget permit it.

Origin down, unknown metrics, unknown/global offline connectivity, an unsupported configuration,
and a healthy HA connection with an isolated public failure suppress automatic restart. The
helper therefore does not fight an app shutdown, a disabled Remote origin, or brief cloudflared
self-recovery. This is deliberately a conservative dead-tunnel recovery mechanism, not a repair
for every network or ingress misconfiguration.

At most three attempts are allowed per rolling 15 minutes, including failed restart commands.
Cooldown grows from 30 seconds with bounded jitter, capped at five minutes; grace still applies.
The budget is persisted before launchctl runs and restored after helper crashes or updates.
Observations and restart commands are bounded and abortable; singleflight checks prevent overlap.

After a restart, subsequent checks verify the new edge registration and public address. The
existing app independently discovers/publishes the replacement endpoint. This helper does not
change that publication ordering or claim the phone consumed the mailbox. Automatic phone
recovery still requires the selected recovery folder and working iCloud sync; otherwise the user
may need to edit the address or rescan.

## Operator commands and evidence

Run `node <skill-directory>/scripts/watchdog.mjs status` for both launchd PID and the persisted
sample. `running` requires that the loaded job's PID matches the recorded process. `sampleFresh`
requires a check within two minutes; an old healthy snapshot is not current health. A read-only
`check` performs a fresh observation without consuming the recovery budget or restarting anything.

Operational files:

- `~/.yachiyo/logs/tunnel-watchdog.log`: startup, reason changes, and restart requests/results.
- `~/.yachiyo/helpers/tunnel-watchdog/status.json`: latest observation, PID, source hash, recovery
  state, and persisted budget; atomically replaced with owner-only permissions.
- `~/.yachiyo/helpers/tunnel-watchdog/installation.json`: installed source and Node executable.

The installer resolves Node out of transient shell-manager symlinks. If that Node version is
removed, install again using an available standalone Node runtime. `uninstall` unloads/removes
only the watchdog LaunchAgent; logs and status remain for diagnosis. It does not stop cloudflared.

## Verification

Run `node --test <skill-directory>/scripts/watchdog-*.test.mjs`. Tests use virtual time and local
HTTP/WS fixtures: dead-but-alive tunnel decisions, origin/global-offline suppression, unknown
metrics, healthy-HA/public failure, restart budget/cooldown persistence, cancellation, timeout,
wake and clock rollback, stale URLs, correct 101 validation, and size bounds. They do not restart
the live tunnel.

After installation, verify a fresh observation and another scheduled sample after startup grace.
Do not deliberately break a healthy user connection just to manufacture a recovery log. A live
fault-injection restart changes a quick address and needs explicit approval; distinguish simulated
policy verification, a live healthy probe, and an actually observed recovery in the report.
