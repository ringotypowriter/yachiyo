---
title: yachiyo remote
description: Inspect Remote access, manage Cloudflare tunnels, and revoke paired phones from the running desktop app.
---

These commands talk to the running desktop app and print JSON. Start Yachiyo
before using them. For Connect activation and phone pairing, use **Settings →
Remote**; see the [Remote access guide](/docs/guides/remote/).

## `remote status`

```bash
yachiyo remote status
```

| Field         | Meaning                                                                                             |
| ------------- | --------------------------------------------------------------------------------------------------- |
| `enabled`     | Whether Remote is enabled in saved settings                                                         |
| `running`     | Whether the local Remote server is listening                                                        |
| `tunnel`      | `relay`, `quick`, `named`, or `none`                                                                |
| `port`        | Active local port, or `null` when the server is stopped                                             |
| `endpoints`   | Advertised tunnel, external, or LAN addresses                                                       |
| `relay`       | Connect activation and connection state, with its service address                                   |
| `cloudflared` | Binary path, managed process state, hostname, and whether a user configuration blocks quick tunnels |
| `icloudDrive` | `available` or `unavailable`; address recovery is macOS-only                                        |
| `pairings`    | Number of saved phone pairings                                                                      |
| `connections` | Number of active phone connections                                                                  |

For Connect, check `relay.connected`; its public route is not listed in
`endpoints`. `running` describes the local server. A running tunnel process or
saved hostname does not confirm public reachability. Verify access on the phone.

## `remote tunnel install`

Installs or replaces a managed Cloudflare tunnel and enables Remote access.
It returns the current status; address discovery can finish after the command.
Wait for an address before pairing.

Install `cloudflared` using the
[Cloudflare downloads guide](https://developers.cloudflare.com/tunnel/downloads/).
On macOS, the bundled `yachiyo-remote` skill can
prepare HTTP/2 and the automatic-recovery watchdog before installing the tunnel.
On Windows, ensure `cloudflared.exe` is on the app's `PATH` and restart Yachiyo
after installation.

### Quick tunnel

```bash
yachiyo remote tunnel install --mode quick
```

Creates a temporary Cloudflare address without a Cloudflare account. The
address can change when the tunnel restarts. If `~/.cloudflared/config.yaml`
exists, installation fails; use a named tunnel instead of deleting that file.

### Named tunnel

Create a named tunnel and its DNS route using Cloudflare's
[locally managed tunnel guide](https://developers.cloudflare.com/tunnel/features/locally-managed-tunnels/create-local-tunnel/).
Yachiyo will generate its own ingress configuration and run the tunnel. Once
the tunnel and DNS route exist, use:

```bash
yachiyo remote tunnel install --mode named --tunnel <name> --hostname <host>
```

Use the existing tunnel's name and its hostname, such as `remote.example.com`.
Both flags are required. Yachiyo writes its own ingress configuration without
replacing your user-level Cloudflare configuration.

On macOS, managed tunnels run as a user LaunchAgent. On Windows, the desktop
app owns the process, so it stops when the app exits. Linux does not support
these install commands; use Connect or an
[external endpoint](/docs/guides/remote/#external-endpoint-or-lan).

Reinstalling replaces the current tunnel process and interrupts access. Keep
the same mode, tunnel name, and hostname when repairing an existing setup.
Reinstalling does not revoke paired phones, but a changed quick-tunnel address
requires address recovery or a new pairing code.

## `remote tunnel uninstall`

```bash
yachiyo remote tunnel uninstall
```

Stops and removes the managed tunnel, then changes `tunnel` to `none`. It keeps
Remote enabled and preserves pairings. A configured external endpoint or LAN
access can still work. It does not remove a tunnel you manage outside Yachiyo.

To stop all Remote connections, turn off **Remote access** in Settings and save.

## `remote pairings list`

```bash
yachiyo remote pairings list
```

Returns the paired phones. Each entry contains `pairingId`, `deviceName`,
`createdAt`, and an optional `lastSeenAt`. Use `pairingId` when revoking access.

## `remote pairings revoke`

```bash
yachiyo remote pairings revoke <pairingId>
```

Revokes that phone's access and disconnects it immediately. The response contains
`revoked`, a boolean. The phone needs a new pairing code to return.

For connection methods, address recovery, and notification setup, see
[Remote access](/docs/guides/remote/). Saved settings are listed under
[`[remote]`](/docs/reference/config-toml/#remote).
