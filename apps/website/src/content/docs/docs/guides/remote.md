---
title: Remote access
description: Pair an iPhone with Yachiyo, choose a connection method, and continue your desktop conversations away from your computer.
---

Yachiyo Remote lets you read and continue conversations from your iPhone. The
paired computer runs the model requests and tools, and keeps the workspace
files. Keep Yachiyo running and the computer awake and online.

You can follow replies and tool calls, send messages and attachments, steer or
stop a run, answer questions, and approve plans. You can also start a new thread
with a workspace and model from the paired computer.

You need the desktop app and Yachiyo Remote on an iPhone running iOS 17 or later.
Keep both apps up to date. Remote is configured in **Settings → Remote** on the
computer. It does not require [Sync](/docs/guides/sync/).

Install the iPhone app through the
[public TestFlight beta](https://testflight.apple.com/join/HnVRy31b).
Install TestFlight on your iPhone first, then open the link to install Yachiyo.
To request a Connect invitation, comment on
[the invitation issue](https://github.com/ringotypowriter/yachiyo/issues/78)
with your desktop platform and a contact email address for receiving the code.

## Connect and pair

If you have a Yachiyo Connect invitation, use **Yachiyo Connect (Recommended)**.
It does not require your own domain, `cloudflared`, or an iCloud recovery folder.
Without an invitation, choose one of the [other connection methods](#other-connection-methods).

1. Open **Settings → Remote** on the computer. Enter your **Invitation code**
   and click **Activate Connect**.
2. Select **Yachiyo Connect (Recommended)** as the connection method, turn on
   **Remote access**, and save the settings.
3. Wait for **Yachiyo Connect connected**. Under **Pair a phone**, click
   **Show code**.
4. Open Yachiyo Remote on the iPhone and scan the code. To add another computer,
   use **Settings → Devices → Add device** on the phone.
5. Open a conversation and send a message. Test once over cellular data to
   confirm you can reach the computer away from its local network.

If the camera cannot scan, use **Copy pairing link** on the computer and
**Paste pairing link** on the iPhone. Copy the full pairing link, not the server
address. Pairing codes expire after five minutes and can be used once.
Generating a new code or link invalidates the previous unused one.

:::caution[Keep pairing codes private]
A pairing code grants access to your computer's assistant and tools. Share it
only with your own phone. Do not post the QR image or pairing link in a public
chat, screenshot, or issue.
:::

## Other connection methods

| Method                | What you need                                                          | Address behavior                                                        |
| --------------------- | ---------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| **Quick tunnel**      | `cloudflared` on macOS or Windows                                      | A temporary Cloudflare address that can change when the tunnel restarts |
| **Named tunnel**      | `cloudflared`, a Cloudflare account, and a domain routed to the tunnel | A hostname you control                                                  |
| **External endpoint** | Your own HTTPS reverse proxy or externally managed tunnel              | The public address you configure                                        |
| **Local network**     | Both devices on the same trusted network                               | The computer's local address; unavailable when you leave that network   |

### Cloudflare tunnels

On macOS, you can ask Yachiyo:

> Set up remote access for my iPhone with a quick tunnel and automatic recovery.

The bundled `yachiyo-remote` skill checks `cloudflared`, prepares the recovery
watchdog, and configures the tunnel to use HTTP/2. It also checks whether iCloud
address recovery is available. The tunnel runs as a macOS LaunchAgent, but
Yachiyo must still be running to serve conversations.

For manual setup, see [`yachiyo remote`](/docs/cli/remote/). Selecting a tunnel
in Settings alone does not install `cloudflared` or create the tunnel. After
setup, wait for a server address, then use **Show code** to pair the phone.

On Windows, install `cloudflared.exe` and make it available on the app's `PATH`.
Restart Yachiyo after installation. The app manages the tunnel process; closing
its last window exits the app and stops the tunnel. Windows has no iCloud
address recovery. Use a named tunnel or stable external endpoint if you want
to avoid pairing again when a quick-tunnel address changes.

Linux desktop builds are experimental. They do not manage Cloudflare tunnels.
Use Yachiyo Connect or an externally managed endpoint instead. Remote also
requires encrypted credentials and an unlocked system wallet; it is unavailable
when the desktop app runs in plaintext credential mode.

### External endpoint or LAN

For a reverse proxy or tunnel you manage yourself:

1. Forward WebSocket requests for `/remote/v1` to
   `http://127.0.0.1:47831` on the computer running Yachiyo. Preserve the
   WebSocket Upgrade headers. If you changed the Remote port, use that port.
2. In **Settings → Remote**, select **External endpoint**. Enter the public
   HTTPS address, such as `https://remote.example.com`, or the full WSS address
   ending in `/remote/v1`.
3. Turn on **Remote access**, save, and pair the phone.

Keep the listener on loopback when the proxy runs on the same computer. If the
proxy runs on another host, enable **Local network** and restrict inbound access
to the proxy at the firewall. Use HTTPS/WSS for public access.

For LAN-only access, select **External endpoint**, leave **Public address**
empty, and enable **Local network**. Save with Remote access on, then pair on the
same network. Local network access can also be enabled alongside a public
connection method.

## Recover a changed address

A quick tunnel can get a new address whenever its process restarts. On macOS,
Yachiyo can publish the replacement address through an encrypted file in iCloud
Drive. This is separate from Yachiyo Sync.

1. Enable iCloud Drive on the Mac and iPhone using the same Apple account.
2. In Yachiyo Remote on the iPhone, open **Settings → Address recovery →
   Yachiyo recovery folder**.
3. Select **iCloud Drive → Documents → Yachiyo**, the folder shared with the Mac.

The folder is optional for pairing and chat. Without it, you may need to scan a
new code after the address changes. Seeing iCloud Drive available on the Mac
does not confirm that the phone has selected the folder. Connect and stable
external addresses do not need this recovery mechanism.

## Completion notifications

Yachiyo Connect supports iPhone alerts when a task completes. The Connect
service and both app builds must support push notifications.

- Keep task-completion notifications enabled in the desktop app's **Settings →
  General**.
- Allow notifications on the iPhone. Use **Settings → Notifications** in
  Yachiyo Remote to enable them or open the system notification settings.
- Reconnect the phone to the computer after changing notification permissions.

An alert shows the conversation title. Tapping it opens that conversation on
the paired computer. Failed and cancelled runs do not produce completion
alerts. The app suppresses foreground banners while it is open. Notifications
do not wake a sleeping computer or run tasks on the phone.

Chat traffic is encrypted between the phone and computer, including when it
passes through Connect or Cloudflare. **Push notifications are separate:
Connect and Apple can see the conversation title and delivery metadata.** The
push payload does not include chat messages, model output, or attachments.

## Disconnect a phone or turn Remote off

In the computer's **Settings → Remote → Paired phones**, choose **Unpair** for
the phone. It disconnects immediately and needs a new pairing code to return.
Removing a computer from the iPhone's device list only removes that phone's
local entry; revoke access on the computer as well.

To stop all Remote connections, turn off **Remote access** and save. This keeps
the pairing records. To remove a managed Cloudflare tunnel, use
[`yachiyo remote tunnel uninstall`](/docs/cli/remote/). That command does not
disable Remote and can leave LAN or external-endpoint access available.

## Troubleshooting

| Symptom                                                | What to check                                                                                                                                                                                                 |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Show code** is unavailable                           | Save with Remote access on. Connect must report connected; other methods need a reachable address.                                                                                                            |
| Connect will not activate                              | Check that the invitation is valid and unexpired, and that the computer can reach the service. Activation and enabling Remote are separate steps.                                                             |
| The phone rejects a pairing link                       | Generate a fresh link. Use **Copy pairing link**, not the server address. Update both apps if the phone reports an unsupported version.                                                                       |
| A quick tunnel will not start                          | Check `cloudflared` is installed. If `~/.cloudflared/config.yaml` exists, use a named tunnel instead of deleting your existing configuration.                                                                 |
| A server address appears, but the phone cannot connect | Check the computer is awake and Yachiyo is running. Test from cellular data; a stored hostname or running `cloudflared` process does not prove the tunnel is reachable.                                       |
| The phone disconnects after a tunnel restart           | Check the Mac and iPhone recovery folder, or generate a new pairing code. Windows needs a stable address or a new code.                                                                                       |
| Closing the Mac lid disconnects the phone              | **Stay awake on power** prevents app suspension on AC power. It does not override system sleep or lid-close sleep.                                                                                            |
| Remote is unavailable in plaintext credential mode     | Restart the desktop app with encrypted credentials and an unlocked system wallet.                                                                                                                             |
| Completion alerts do not arrive                        | Check Connect is in use, desktop notifications are enabled, and iPhone permissions allow alerts. Reconnect after changing permissions; also check Focus settings and push support in your builds and service. |

Use [`yachiyo remote status`](/docs/cli/remote/) to inspect the service, tunnel,
pairings, and connection counts. The
[`[remote]` configuration reference](/docs/reference/config-toml/#remote)
lists the saved settings and their defaults.
