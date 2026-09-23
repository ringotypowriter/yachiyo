---
name: yachiyo-remote
description: Set up phone remote access for Yachiyo on this Mac — check iCloud Drive, install cloudflared, choose a quick or named Cloudflare tunnel, and hand the user to Settings > Remote to pair their iPhone by QR code. Use when the user wants to use Yachiyo from their phone or asks about remote access, tunnels, or pairing. macOS only.
platforms: darwin
---

# Yachiyo Remote

Phone remote access lets a paired iPhone follow and drive chats on this Mac. The app hosts a
loopback-only encrypted WebSocket service; `cloudflared` runs as a LaunchAgent so the public
tunnel outlives app restarts. Traffic is end-to-end encrypted between phone and Mac, so
Cloudflare only relays ciphertext.

This skill is for one-time setup. Change app state **only** through the `yachiyo remote` CLI —
never edit `config.toml`, LaunchAgent plists, or `~/.cloudflared` files by hand.

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

A quick tunnel's address changes when the Mac restarts. The app writes the new address, encrypted,
to iCloud Drive so the phone can find the Mac again without rescanning. This needs **iCloud Drive
turned on** in System Settings — it does not need Yachiyo Sync.

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
  no uptime guarantee; the address changes after a Mac restart and phones recover it through
  iCloud Drive.
- **Named tunnel** (advanced): a fixed address on a domain the user owns, through their own
  Cloudflare account. More reliable; needs a Cloudflare account and a domain whose DNS is on
  Cloudflare.

### 5a. Quick tunnel

If `cloudflared.conflictingUserConfig` is `true`, a quick tunnel cannot run while
`~/.cloudflared/config.yaml` exists. Explain this and recommend a named tunnel instead; do not
delete or rename the user's file.

Otherwise run `yachiyo remote tunnel install --mode quick`.

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

Run `yachiyo remote status` and check that `running` is `true`, `cloudflared.agentRunning` is
`true`, and `endpoints` contains a `tunnel` entry. A quick tunnel can take up to 30 seconds to
report its address; poll a few times before concluding it failed. If cloudflared is not running,
read the end of `~/.yachiyo/logs/cloudflared.log` for the reason.

### 7. Pair the phone

Tell the user to open **Settings > Remote** in Yachiyo, click **Show code**, and scan it with
Yachiyo on their iPhone within five minutes. Never print or paste the pairing link in chat — it
grants access to this Mac.

## Other tasks

- **Unpair a phone**: `yachiyo remote pairings list`, confirm which one with the user, then
  `yachiyo remote pairings revoke <pairingId>`.
- **Turn the tunnel off**: `yachiyo remote tunnel uninstall` (phones on the same network can still
  connect if the local network option is on in Settings > Remote).
- **Lid closed**: a Mac with its lid closed sleeps and cannot be reached; "Stay awake on power" only
  prevents idle sleep.
