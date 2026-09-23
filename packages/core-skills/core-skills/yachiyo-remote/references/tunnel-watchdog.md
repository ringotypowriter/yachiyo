# Tunnel watchdog design

**Status: proposed, not implemented.** This is a repository-facing design reference, not an installation procedure or a claim that automatic recovery exists. Implement future changes in the code repository; do not edit installed core/custom skills under `~/.yachiyo`.

## Motivation and current boundaries

The reported incident had a live `cloudflared` process already using `--protocol http2`, but `cloudflared_tunnel_ha_connections` was zero. The public WebSocket request returned HTTP 530 / Cloudflare 1033 while the local origin accepted a WebSocket upgrade with HTTP 101. This supports a connector-health failure, not an origin failure; process liveness alone did not establish reachability.

Current implementation anchors (paths relative to the repository root):

- `apps/desktop/src/main/remote/tunnelSupervisor.ts`: owns `sh.ringo.yachiyo.cloudflared`, installed as a per-user KeepAlive LaunchAgent. `status()` reports `agentRunning` from `launchctl print`. `monitor()` currently polls only quick tunnels, every 30 seconds, to discover the hostname via `/quicktunnel`; it does not assess connector health or restart unhealthy connectors. Each fetch has a three-second timeout, but polling has no singleflight or generation guard. Empty/failed responses retain the last hostname.
- `apps/desktop/src/main/remote/remoteController.ts`: starts the origin before monitoring, stops monitoring when remote access is disabled, and forwards endpoint changes to `service.publishEndpoints()`.
- `apps/desktop/src/main/remote/remoteService.ts` and `mailboxWriter.ts`: publish encrypted endpoint lists for existing pairings. The writer deduplicates unchanged lists, increments persistent per-pairing counters and atomically renames each mailbox file. It skips empty endpoint lists and unavailable iCloud Drive; these are not revocation acknowledgements.
- `apps/desktop/src/main/remote/remoteCommands.ts`: exposes install/uninstall/status wiring. Installation rewrites the owned plist, attempts `bootout`, then `bootstrap`; it is not a lightweight watchdog restart API.

Quick-tunnel HTTP/2 is **already implemented** in `cloudflaredArguments()`. Applying a protocol policy to named tunnels requires an explicit product decision; this design does not authorize a blanket named-tunnel/config rewrite.

## Ownership and health model

Extend the existing `TunnelSupervisor`, with injected probes, clock, randomness and restart runner. Keep launchd responsible for process lifetime; do not add a second watchdog daemon, another cloudflared process, or a competing launchd job. Future monitoring should cover both quick and named tunnels (named endpoints retain their configured hostname).

Keep `agentRunning` as a process fact. Add separate proposed health/recovery fields: connector health (`healthy`, `unhealthy`, `unknown`) and phase such as `observing`, `grace`, `recovering`, `cooldown` or `suppressed`, with the reason and last probe/restart timestamps. A Cloudflare-unhealthy connector must remain distinguishable from a stopped process.

Use three independent signals:

| Signal                                                                   | Interpretation                                                                                                                                                                                              |
| ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Local metrics `/metrics`, especially `cloudflared_tunnel_ha_connections` | A valid zero indicates no registered connections. Missing, malformed, timed-out or unavailable metrics mean **unknown**, never zero. Positive connections do not prove the public origin route works.       |
| Local upgrade at `ws://127.0.0.1:<port>` plus `REMOTE_WS_PATH`           | HTTP 101 establishes origin WebSocket availability; close the probe promptly without pairing or exercising application operations. Origin failure suppresses connector restarts.                            |
| Occasional public upgrade at the current tunnel endpoint                 | HTTP 101 verifies the public WebSocket route. Record HTTP 530 / CF1033 separately from DNS/TLS/timeouts and other failures. A transient public failure with healthy connections does not trigger a restart. |

Do not add a blanket HTTP 200 root handler or treat an ordinary root GET as a WebSocket health check. A successful upgrade verifies transport reachability, not authenticated chat functionality.

## Proposed recovery policy

Starting defaults below are tunable policy, not existing behavior:

1. Run one bounded probe cycle at a time, on a 30-second cadence. Give every metrics/local/public probe an explicit timeout and cancellation; public checks may be less frequent in steady state and run on suspicion or recovery. Serialize restart actions with monitoring, installation and shutdown.
2. Allow a 90-second startup/restart/wake grace period (three 30-second intervals). After grace, require three consecutive eligible observations of valid zero connections with a healthy origin before recovery. Public CF1033 corroborates the incident; a lone public failure or unknown metrics does not count as a zero-connection sample.
3. Suppress restart decisions while the origin is down, remote access/app is off, the Mac is sleeping, or a known global connectivity outage is present. Reset the consecutive-failure streak on suppression, healthy samples or unknown samples; resume through grace after wake/connectivity recovery. Observe uncertainty rather than turning it into restart evidence.
4. Restart only the verified, owned per-user LaunchAgent: the future action should use `launchctl kickstart -k gui/<uid>/sh.ringo.yachiyo.cloudflared`, through the supervisor's bounded command runner. Verify ownership before acting; missing/unowned agents require explicit operator action. No `sudo`, broad process kills, unrelated agents, plist rewrites or configuration-root changes.
5. Apply exponential backoff with bounded jitter and a rolling budget of at most three restart attempts per 15 minutes, including failed attempts. On exhaustion, enter observation-only cooldown (initial proposal: 10 minutes), continuing non-disruptive probes. Automatically leave cooldown when its timer and rolling budget permit, then require fresh eligible evidence; a successful probe can restore healthy observation without a restart. Do not leave recovery permanently disabled or burst accumulated ticks after sleep.

A CLI restart wrapper is **future work**, not an available `yachiyo remote` command. It should delegate to the same ownership checks, serialization and budget rather than create another recovery loop. In the reported manual CLI reinstall, the first bootstrap failed with error 5; a second attempt succeeded after unload. Preserve that diagnostic context, allow only controlled bounded retry where appropriate, and prefer kickstarting an existing agent over repeated reinstall/bootstrap or privilege escalation.

## Endpoint recovery and publication

A quick-tunnel restart may rotate its URL. Add a generation token spanning configuration, monitoring, restart and publication. Increment/invalidate it before restart, configuration replacement or stop; cancel old probes and discard every late result whose generation no longer matches. A pre-restart `/quicktunnel` response must never overwrite a recovered endpoint or reach a new service through the controller callback.

Recovery sequence:

1. Mark the previous quick URL stale for recovery decisions; retaining it as diagnostic history must not certify it as healthy.
2. Wait for registration (valid positive connection metrics) and a freshly queried `/quicktunnel` URL from the current generation. Fresh means observed after this restart, not necessarily a different hostname. Named tunnels use the current configured hostname instead.
3. Verify local and candidate public WebSocket upgrades before accepting the recovered endpoint. Abort publication on generation/configuration changes, failed verification or shutdown.
4. Commit the current-generation endpoint through the controller/service publication path. Serialize endpoint snapshots and mailbox writes so an older asynchronous publication cannot overwrite a newer endpoint configuration, even with a higher mailbox counter. Preserve monotonically increasing per-pairing counters; counters alone do not prevent stale-content races.

Keep existing pairings, desktop identity and Noise/mailbox keys. Address recovery does not require re-pairing. It also does not guarantee phone reconnection: desktop mailbox publication requires available iCloud Drive, and the phone needs its selected, accessible iCloud `Documents/Yachiyo` recovery folder and completed sync. Without that setup, do not claim a rotated quick URL automatically reaches the phone. Health, endpoint acceptance, mailbox write and phone reconnection are separate outcomes.

## Acceptance tests and diagnostics

Use fake clocks, deterministic jitter and injected metrics/upgrade/command adapters; policy tests must use no network, real launchctl or installed configuration roots.

- Reproduce healthy local HTTP 101 + remote HTTP 530/CF1033 + valid zero connections; recover only after grace and the consecutive threshold.
- Keep healthy connections with a transient public failure restart-free; treat unavailable/malformed metrics as unknown.
- Verify origin failure, disabled remote access, sleep and global connectivity suppression, plus wake grace and automatic cooldown resumption.
- Prove singleflight, probe cancellation, bounded command timeouts, backoff and the three-per-15-minute budget, including failed restarts and delayed timer ticks.
- Resolve old probes/publications after a restart, configuration change and stop; none may overwrite the current generation. Require registration and fresh URL verification before publishing; ensure serialized mailbox counters and endpoint contents progress together.
- Preserve pairings/keys and named hostname configuration. Cover absent iCloud/folder access without promising phone recovery. Assert no writes to other configuration roots, user cloudflared config, installed skills or unrelated agents.

Extend `tunnelSupervisor.test.ts`, `remoteController.test.ts`, `remoteService.test.ts` and `mailboxWriter.test.ts` at those module boundaries. Log signal classifications, generation, phase, suppression reason, attempt count and next eligible retry time without pairing secrets. Tests should distinguish connector recovery from successful endpoint publication and eventual phone recovery.
