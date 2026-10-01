# APNs task-completion notifications

The iPhone receives visible task-completion alerts through Relay. Each alert shows the conversation title and “Your task has finished.” Tapping it opens that conversation on its paired Mac. The Mac must remain running and online.

## Setup

- Install desktop and iPhone builds supporting push registration. Existing pairings can be reused.
- On the Mac, enable Remote, select **Relay (Recommended)** and activate it with an invitation. Keep General task-completion notifications enabled.
- Allow notifications on the iPhone. If permission was denied, enable it in iOS Settings and return to Yachiyo while the Mac is reachable.
- Set all five APNs variables on Relay and redeploy:

| Variable | Value |
| --- | --- |
| `APNS_PRIVATE_KEY` | Complete APNs `.p8` PEM, including header/footer; actual newlines or literal `\n` |
| `APNS_KEY_ID` | APNs Key ID |
| `APNS_TEAM_ID` | Apple Developer Team ID |
| `APNS_TOPIC` | `sh.ringo.yachiyo.remote` for the standard app target |
| `APNS_ENVIRONMENT` | `production` for TestFlight/App Store; `sandbox` for development-signed builds |

The key must authorize the app's topic and environment. Enable Push Notifications for the app identifier in Apple Developer if signing reports an entitlement mismatch. The target declares `aps-environment`; distribution signing supplies the production value. Do not mix sandbox device tokens with a production Relay. Without APNs variables the Relay continues working but does not send alerts.

## Data and lifecycle

The iPhone sends its current device token to paired Macs through the authenticated Noise-encrypted RPC connection. The Mac encrypts that token at rest; public pairing records and audit logs never expose it. Each encrypted connection refreshes registration. Permission denial clears it after reconnecting. Forgetting a Mac attempts an encrypted opt-out while the link is online; revoking the pairing on the Mac is the authoritative way to remove authorization.

Push carries only the device token, conversation title, thread ID and remote-device ID. **Relay and Apple can see the title and routing metadata; alerts are not end-to-end encrypted.** Chat messages, model output and attachments are not included. Threads unavailable in the Remote inbox are not pushed. Failed and cancelled runs do not produce completion alerts.

Notifications group by Mac and conversation. The iPhone suppresses foreground banners while Yachiyo is open; the inbox and conversation update through the encrypted event stream instead. Routes require a currently paired Mac identity; old notifications cannot reopen a removed pairing.

There are no blind retries. APNs `410` and explicit HTTP `400` reasons `BadDeviceToken` / `DeviceTokenNotForTopic` clear only the rejected token, preserving a newer registration. Other failures retain the token. Shutdown aborts and drains outstanding pushes before releasing the pairing store. Apple accepting a request does not guarantee delivery; permissions, Focus settings and device/network conditions apply.

## Verification

Unit tests cover token validation, encrypted registration, opt-out/revocation, payloads, shutdown races and iOS routing. The Relay acceptance test runs a real Bun HTTP/WebSocket server, Noise pairing, registration and a completed task; only the final Apple transport is substituted to inspect its alert headers and payload. Live delivery needs real Apple credentials and a physical device with a matching signed build.
