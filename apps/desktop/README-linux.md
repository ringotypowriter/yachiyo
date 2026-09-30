# Linux VM Remote setup

The Linux x64 desktop build provides the same Remote WebSocket service and pairing flow as the macOS app. Run it in a Linux desktop session with a working system credential store (for example, GNOME Keyring or KWallet). Encrypted mode rejects Electron's insecure `basic_text` storage backend. An explicit provider-only plaintext fallback is described below; Remote pairing still requires a working wallet.

## Desktop prerequisites

- Use an x64 Linux desktop session with its session D-Bus available. Installing `libsecret` alone does not provide a working credential store: GNOME Keyring or KWallet must also be configured and unlocked in that session. A fresh wallet may require first-time setup by the user.
- If the credential store is unavailable, unlock the wallet and restart, or explicitly choose the provider-only plaintext fallback using the startup flag described below. Corrupt encrypted credentials are not silently downgraded or overwritten.
- Source builds require the pinned Node/pnpm versions, a Rust toolchain, and a C/C++ build toolchain. Run `pnpm install`, then `pnpm build:linux` for AppImage and deb packages. The build prepares Electron-native dependencies and both Rust helpers.
- Native SQLite modules must match Electron's ABI, not the host Node ABI. For a source checkout, `pnpm run native:prepare` repairs those bindings. For an installed package, reinstall the matching system/architecture package if the application log reports a native-module startup failure.

## Remote access

1. Start Yachiyo on the VM and configure a model/provider. In **Settings → Remote**, enable Remote access, choose **External endpoint**, and set **Public address** to the externally reachable HTTPS address (or full WSS WebSocket address). The address is saved in `config.toml` as `remote.publicEndpoint` and embedded in new pairing codes. Keep the local listener on its default port `47831` unless you need another port.
2. Provide one of these ingress routes:
   - **Public IP:** terminate TLS with a publicly trusted certificate at a reverse proxy on the VM. Forward `/remote/v1` with WebSocket Upgrade support to `http://127.0.0.1:47831`. A hostname with a valid certificate is the simplest option; a bare IP works only if the certificate is trusted by iOS **and covers that IP address**. Set the public address to the proxy's `https://` URL. Do not expose unencrypted `ws://` to the internet.
   - **Cloudflare Named Tunnel:** run `cloudflared` as a Linux service outside Yachiyo, route your hostname to `http://127.0.0.1:47831`, and set the public address to `https://<your-hostname>`. This also works when the VM has no inbound public IP. Built-in tunnel installation is unavailable on Linux and returns external-ingress setup guidance. If settings were copied from another platform, select **External endpoint** in the existing Tunnel dropdown to replace the saved quick/named mode; Yachiyo does not manage or stop externally configured tunnels.
3. Save settings and confirm **Server address** shows `wss://<your-host>/remote/v1`. Generate a fresh pairing code and scan it with the iPhone app. Test on cellular data, not just the VM's local network: a code can contain a syntactically valid address even when the proxy, firewall, DNS, or certificate is wrong.

The Remote listener remains bound to `127.0.0.1` unless **Local network** is separately enabled. If the reverse proxy runs on another host, enable Local network and restrict port `47831` to that proxy at the firewall. iCloud address recovery is macOS-only; use a stable public hostname on Linux because phones need to rescan after an endpoint change.

### Explicit plaintext credential fallback

Encrypted credential storage remains the default. If the system wallet is unavailable,
startup fails with actionable guidance in the application log. Start Yachiyo with
`--yachiyo-plaintext-credentials` to explicitly opt into plaintext storage and skip
wallet access entirely, including when a wallet call would otherwise hang. This flag
works for both the desktop and headless CLI. No dialog, banner, or settings control is
added; the selected mode and its consequences are logged at startup.

This mode stores provider API keys and provider private keys **unencrypted** in
`provider-credentials.plaintext.json` in the Yachiyo data directory. Other processes or
people able to read that file can read the credentials. The file is excluded from the
current built-in settings sync, but ordinary directory backups can still copy it.

Existing `provider-credentials.enc` and `provider-credentials.key` are not changed or
unlocked in plaintext mode. Previously encrypted credentials are unavailable; the two
stores are independent and never automatically merged. If a plaintext file exists, the
next start requires an explicit storage-mode flag, rather than silently switching
stores when the wallet recovers. Returning to encrypted mode does not delete the plaintext file.

When a plaintext store exists, desktop startup and headless credential/config commands require an explicit
`--yachiyo-plaintext-credentials` or `--yachiyo-encrypted-credentials` choice. Commands
that do not open a config service (such as help or doctor) do not unlock either store.

Remote access requires encrypted mode and an unlocked system wallet. In plaintext mode,
Yachiyo leaves saved Remote settings and pairing files unchanged but does not start its
Remote service or access Remote wallet secrets.
