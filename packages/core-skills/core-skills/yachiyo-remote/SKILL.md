---
name: yachiyo-remote
description: Set up and troubleshoot phone remote access on this Mac — check iCloud address recovery, manage Cloudflare tunnels, verify HTTP/2 and public WebSocket health, and install the bundled automatic-recovery watchdog. Use for iPhone remote setup, pairing, disconnections, tunnels, or automatic recovery. macOS only.
platforms: darwin
---

# Yachiyo Remote

Phone remote access lets a paired iPhone follow and drive chats on this Mac. The app hosts a
loopback-only encrypted WebSocket service; `cloudflared` runs as a LaunchAgent so the public
tunnel outlives app restarts. Traffic is end-to-end encrypted between phone and Mac, so
Cloudflare only relays ciphertext.

Change app state **only** through the supported `yachiyo remote` CLI —
never edit `config.toml`, LaunchAgent plists, or `~/.cloudflared` files by hand.
The bundled watchdog installer below manages its own helper and restarts only Yachiyo's tunnel;
it does not change app configuration or pairings.
Read-only inspection of the owned LaunchAgent, metrics, and logs is useful for diagnosis. For
bundled skill changes, edit `packages/core-skills/core-skills/yachiyo-remote/` in the source
repository, not the installed copy under `~/.yachiyo/skills/core/` or a custom shadow skill.

```
yachiyo remote status
yachiyo remote tunnel install --mode quick
yachiyo remote tunnel install --mode named --tunnel <name> --hostname <host>
yachiyo remote tunnel uninstall
yachiyo remote pairings list
yachiyo remote pairings revoke <pairingId>
```

All commands print JSON and need the app running (it is, since you are running inside it).

## Setup flow

Follow these steps in order. Tell the user what each step is for in one short sentence.

### 1. Check the current state

Run `yachiyo remote status`. Note `icloudDrive`, `cloudflared.path`,
`cloudflared.conflictingUserConfig`, `tunnel`, and `running`.

### 2. iCloud Drive (address recovery)

A quick tunnel's address can change whenever its cloudflared process is recreated, not just when
the Mac restarts. The app writes the new address, encrypted,
to iCloud Drive so the phone can find the Mac again without rescanning. This needs **iCloud Drive
turned on** in System Settings — it does not need Yachiyo Sync. The phone must also have selected
the shared recovery folder in its Remote settings; Mac-side `icloudDrive: available` alone does
not prove the phone can recover an address change.

If `icloudDrive` is `unavailable`:

1. Explain the benefit above and ask whether to open the iCloud settings.
2. If the user agrees, run `open "x-apple.systempreferences:com.apple.systempreferences.AppleIDSettings"`.
   If that opens nothing useful on this macOS version, run `open -b com.apple.systempreferences`
   and tell the user to click their name, then **iCloud**, then turn on **iCloud Drive**.
   You cannot flip this switch yourself; macOS offers no API for it.
3. Poll `yachiyo remote status` every 3 seconds for up to 5 minutes until `icloudDrive` becomes
   `available`, then continue without asking the user to come back.
4. If the user declines or it times out, continue anyway and say that after the address changes
   they will need to scan a new code.

### 3. cloudflared

If `cloudflared.path` is `null`, install it with `brew install cloudflared` (ask first if Homebrew
installs need the user's approval in this session). Re-run `yachiyo remote status` afterwards.

### 4. Choose a tunnel

Ask the user which tunnel to use:

- **Quick tunnel** (default, no account): a random `*.trycloudflare.com` address. Free, no setup,
  no uptime guarantee; recreating cloudflared can change the address. Phones with the recovery
  folder configured can discover the replacement through iCloud Drive.
- **Named tunnel** (advanced): a fixed address on a domain the user owns, through their own
  Cloudflare account. More reliable; needs a Cloudflare account and a domain whose DNS is on
  Cloudflare.

### 5a. Quick tunnel

If `cloudflared.conflictingUserConfig` is `true`, a quick tunnel cannot run while
`~/.cloudflared/config.yaml` exists. Explain this and recommend a named tunnel instead; do not
delete or rename the user's file.

Otherwise run `yachiyo remote tunnel install --mode quick`.

Current quick-tunnel installs explicitly use `--protocol http2`, reducing dependence on QUIC/UDP
on proxy/TUN networks. Verify the actual launch arguments or the latest registered-connection
log, rather than assuming an older installed agent has this setting. HTTP/2 is a transport choice,
not a health check: edge registration can still fail while the process remains alive. Named
tunnels are not forced to HTTP/2 by the current installer; preserve the selected mode and the
user's routing configuration instead of silently treating it as a quick tunnel.

### 5b. Named tunnel

1. Confirm the user has a Cloudflare account and a domain on Cloudflare. If not, explain that they
   can create a free account at dash.cloudflare.com and add a domain (or move an existing domain's
   nameservers to Cloudflare), then stop until they are ready.
2. `cloudflared tunnel login` — opens a browser for the user to pick the domain. Wait for it to
   finish.
3. `cloudflared tunnel create yachiyo-<short name for this Mac>`
4. `cloudflared tunnel route dns <tunnel name> <hostname>` — for example
   `yachiyo.example.com`.
5. `yachiyo remote tunnel install --mode named --tunnel <tunnel name> --hostname <hostname>`

The app writes its own ingress file under `~/.yachiyo/remote/` and passes it with `--config`, so
the user's existing cloudflared configuration is left alone.

### 6. Verify

Run `yachiyo remote status` to discover the origin port, tunnel mode, and current public endpoint.
`running` describes the local service; `cloudflared.agentRunning` describes a process, and a
remembered hostname may be stale. None proves public reachability. Allow at least 30 seconds for
startup/address discovery before judging a new tunnel.

Check the path in layers:

- Send a WebSocket upgrade to `http://127.0.0.1:<port>/remote/v1`; `101 Switching Protocols`
  verifies the origin. An ordinary HTTP request may return 404 on this WebSocket-only path.
- Read cloudflared's loopback `/metrics` endpoint, using the `--metrics` address from the owned
  LaunchAgent. `cloudflared_tunnel_ha_connections > 0` means there is an edge connection;
  zero means none. Missing or unreadable metrics mean unknown, not zero.
- Send the same upgrade to the public endpoint, replacing `wss://` with `https://` for curl.
  Use HTTP/1.1 with `Connection: Upgrade`, `Upgrade: websocket`, `Sec-WebSocket-Version: 13`,
  and a valid base64-encoded 16-byte `Sec-WebSocket-Key`. Apply a short timeout and close the
  probe; do not send a pairing grant or leave an idle socket open.

A proxy's `200 Connection established` is not the final response. The public endpoint must return
`101`. Curl can then time out because the socket intentionally stays open; a timeout _after_ 101
does not undo a successful upgrade. This validates transport, not authenticated phone access.
Do not call the phone connected until its own connection/hello succeeds.

### 7. Pair the phone

For a **private, local Yachiyo conversation**, use the `createRemotePairingQr` agent tool after
remote access is enabled. It returns Markdown containing a short local `yachiyo-asset://` image
reference (not the pairing URL or base64 image data); include that Markdown
**unchanged** in the assistant reply so the user can scan it in Yachiyo on their iPhone within
five minutes. Do not put the pairing link in plain text, copy the image to another conversation,
send it to a group or external channel, upload it, or make another copy on disk. The QR itself is a bearer
grant; treat its image and the chat history containing it as sensitive. If the tool is unavailable
or the image has expired, tell the user to open **Settings > Remote**, click **Show code**, and
scan the new code there. Never invent or reconstruct a pairing URL.

## Other tasks

- **Unpair a phone**: `yachiyo remote pairings list`, confirm which one with the user, then
  `yachiyo remote pairings revoke <pairingId>`.
- **Turn the tunnel off**: `yachiyo remote tunnel uninstall` (phones on the same network can still
  connect if the local network option is on in Settings > Remote).
- **Lid closed**: a Mac with its lid closed sleeps and cannot be reached; "Stay awake on power" only
  prevents idle sleep.

## Recover an offline tunnel

First compare local WS, metrics, public WS, and recent timestamped entries in
`~/.yachiyo/logs/cloudflared.log`. A healthy local upgrade together with public HTTP 530 /
Cloudflare 1033 and zero edge connections identifies a tunnel outage, even with an alive process
and HTTP/2 enabled. Conversely, failed origin checks belong to the local Remote service; public
DNS/TLS timeouts without corroborating edge failure do not by themselves justify restarting it.

When a restart is warranted, explain that a quick-tunnel address can change and obtain approval
unless the user has already asked to restart/recover it. Re-run the supported install command
for the **existing** mode: quick uses `yachiyo remote tunnel install --mode quick`; named uses
the original tunnel name and hostname. Preserve pairing keys and records, other LaunchAgents,
and the user's cloudflared configuration. Do not uninstall remote access or revoke phones as a
substitute for recovering a tunnel.

The current installer unloads then bootstraps the agent. If bootstrap returns error 5 immediately
after unload, inspect the owned service with `launchctl print gui/<uid>/sh.ringo.yachiyo.cloudflared`
and validate its plist read-only. Once it is absent and shutdown has settled, retry the same CLI
operation once. A repeated failure needs diagnosis; do not blindly retry, edit the plist, or use
sudo just because launchctl suggests it.

Repeat the layered health checks after recovery. Confirm the replacement endpoint appears in
Remote status; explain iCloud recovery versus rescanning if it changed. Preserve uncertainty
about phone-side recovery rather than inferring it from Mac-side iCloud availability.

## Automatic recovery

LaunchAgent `KeepAlive` only replaces an exited process; it cannot fix a live process stuck with
zero edge connections. This skill bundles a dependency-free Node watchdog in `scripts/`.
When the user asks for automatic recovery, install and verify it, rather than only writing a plan.
During setup, explain that automatic quick-tunnel recovery can change the address and confirm
the user wants it. Read [references/tunnel-watchdog.md](references/tunnel-watchdog.md) for the
policy, ownership boundaries, and operational files.

Use a standalone Node.js runtime, not the Electron/Yachiyo executable. Resolve the current skill
directory and run:

```
node resources/core-skills/yachiyo-remote/scripts/watchdog.mjs install
node resources/core-skills/yachiyo-remote/scripts/watchdog.mjs status
node resources/core-skills/yachiyo-remote/scripts/watchdog.mjs check
node resources/core-skills/yachiyo-remote/scripts/watchdog.mjs uninstall
```

`install` starts the managed watchdog without restarting a healthy tunnel or the app. It copies
the bundled scripts to `~/.yachiyo/helpers/tunnel-watchdog/` and registers the single owned
`sh.ringo.yachiyo.tunnel-watchdog` LaunchAgent. `check` is a read-only live probe. `uninstall`
removes only the watchdog job, not the tunnel or phone pairings. Update code in the source skill
and rerun `install`; do not patch the generated runtime copy or the installed skill by hand.

Verify `running`, `sampleFresh`, and the observation fields in `status`. After startup grace,
check another sample to establish that it continues running. Report the actual PID, last check,
and probe results. A successful install command alone does not prove continuous monitoring or
phone recovery. Keep the current healthy connection intact; use the included deterministic tests
for failure/restart policy unless a live outage test has been explicitly approved.
