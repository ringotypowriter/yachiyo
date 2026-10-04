---
'@yachiyo/desktop': patch
---

Start with plaintext provider credential storage when the system wallet is unavailable instead of exiting, so the Linux desktop app opens in sessions without GNOME Keyring or KWallet. Pass `--yachiyo-encrypted-credentials` to require encrypted storage.
