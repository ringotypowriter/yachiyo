# Yachiyo headless

Run the assistant on Debian without Electron, a graphical session, D-Bus, or a desktop wallet.
One Node process runs the assistant, schedules, channels, and Remote listener. SQLite stores conversations.
The CLI connects through an owner-only Unix socket in `YACHIYO_HOME`. This host shares the
[app server](../../packages/runtime/src/appServer) with the desktop target. Its
loopback WebSocket API is for local clients; expose only the encrypted Remote endpoint.

This is an experimental source-built target. Use Node **22.22.1** and a separate data directory
from the desktop app. Do not open the same data directory with both hosts.

## Build and install

On the target Debian machine, install Node, pnpm 10, Rust, Python 3, and a C/C++ toolchain.
Build the two native helpers for that machine, then package the JavaScript:

```sh
nvm use
pnpm install --ignore-scripts
pnpm process-host:build
pnpm sync-core:build
pnpm build:headless
```

`build:headless` only bundles JavaScript and copies resources. It reads `process-host` and
`sync-core` from `apps/desktop/resources/bin/linux-<arch>/`. Set `YACHIYO_HEADLESS_BIN_DIR`
to use a different directory containing helpers built from this checkout for the target host.
The bundle includes SQLite migrations, REPL workers, and core skill files.

Copy `apps/headless/dist/` to `/opt/yachiyo/`, **outside the pnpm workspace**, then install
its production dependencies there:

```sh
cd /opt/yachiyo
npm install --omit=dev
export PATH="/opt/yachiyo:$PATH"
export YACHIYO_HOME="$HOME/.yachiyo-headless"
yachiyo init
```

This installation gives `better-sqlite3` the Node ABI. Do not copy the desktop app's
`node_modules` into it. `node` must be on the service's PATH.

For source development, use `pnpm headless <command>`. Source `serve` also needs SQLite
bindings for Node; an existing checkout whose bindings were rebuilt for Electron should use
the separate installation above.

## Configure and chat

Configure a provider before starting a conversation:

```sh
yachiyo provider list
yachiyo provider update OpenAI --payload '{"apiKey":"YOUR_API_KEY","modelList":{"enabled":["YOUR_MODEL_ID"]}}'
yachiyo provider set-default OpenAI --model YOUR_MODEL_ID
yachiyo serve
```

In another terminal with the same `PATH` and `YACHIYO_HOME`:

```sh
yachiyo chat
yachiyo chat 'Explain the files in this project' --workspace /srv/project
yachiyo chat --thread THREAD_ID 'Continue'
printf '%s\n' 'Summarize this text' | yachiyo chat --json
```

Interactive chat keeps the same thread and accepts answers to `askUser` questions. `/exit`
leaves the session. Ctrl-C during a reply cancels the run. The CLI prints the thread ID on
stderr; `--json` emits newline-delimited accepted and runtime events on stdout. Piped
conversations that require a tool answer fail and cancel the run instead of waiting forever.
After a connection failure, resume the saved thread with `--thread`.

`config`, `provider`, and `agent` commands use the running service when available. They can
also run offline with the master key. `thread`, `soul`, `schedule`, `channel`, and `send`
retain their existing CLI forms. Notifications are written to the service log.

`yachiyo server status` reports the running service. `yachiyo server stop` requests a graceful
shutdown. Under systemd, use `systemctl stop yachiyo` to keep the service stopped according to
the unit's restart policy. The desktop and headless credential formats remain separate.

## Remote

Use an external TLS proxy or an activated Yachiyo Connect relay. For a proxy:

```sh
yachiyo config set remote.tunnel none
yachiyo config set remote.publicEndpoint https://yachiyo.example.com
yachiyo config set remote.enabled true
yachiyo remote status
yachiyo remote pair
```

Forward `/remote/v1` with WebSocket Upgrade support to `http://127.0.0.1:47831`.
The TLS certificate must be trusted by the phone. `remote pair` returns a five-minute
pairing URL as JSON. Open the URL on the phone, or encode it as a QR code and scan it in
Yachiyo Remote. Treat the URL as an invitation to access this assistant.

For Yachiyo Connect, start with Remote disabled, run `yachiyo remote activate <invitation-code>`,
set `remote.tunnel` to `relay`, and enable Remote. Settings apply live. Pair after the relay
connection is ready. `remote pairings list` and `remote pairings revoke <id>` manage phones.

The listener binds to loopback by default. `remote.lanEndpoint = true` binds to all IPv4
interfaces and adds LAN addresses to pairing invitations. Built-in quick/named tunnel
installation and iCloud endpoint recovery are not provided by this host.

## Credentials and systemd

`init` creates a random 32-byte `headless-master.key` with mode `0600`. Provider keys and
Remote secrets use authenticated encryption with separate keys derived from that file.
Back up the master key with the data; losing it makes encrypted credentials and pairings
unreadable. The host refuses to reuse a desktop wallet or plaintext credential store.
To migrate provider settings, use the desktop CLI's encrypted `provider export`, then
`provider import <backup> --password-stdin` here.

Key location precedence:

1. `YACHIYO_MASTER_KEY_FILE`
2. `$CREDENTIALS_DIRECTORY/yachiyo-master-key` (systemd credentials)
3. `$YACHIYO_HOME/headless-master.key`

The key file must contain exactly 32 raw bytes and have no group/world permissions.

The included `yachiyo.service` assumes Node is available in `/usr/local/bin` or `/usr/bin`.
If Node was installed with nvm, adjust the unit's `PATH` to include that Node installation;
systemd does not load nvm's shell initialization.

The unit uses `/opt/yachiyo`, a `yachiyo` service account, and
`/var/lib/yachiyo` for data. Create the account and data directory, run `init` as that account,
then install the unit:

```sh
sudo useradd --system --home-dir /var/lib/yachiyo --create-home yachiyo
sudo chmod 700 /var/lib/yachiyo
sudo -u yachiyo env PATH=/opt/yachiyo:/usr/local/bin:/usr/bin:/bin YACHIYO_HOME=/var/lib/yachiyo yachiyo init
sudo cp /opt/yachiyo/yachiyo.service /etc/systemd/system/yachiyo.service
sudo systemctl daemon-reload
sudo systemctl enable --now yachiyo
sudo journalctl -u yachiyo -f
```

Run administrative and chat commands as the same account with `YACHIYO_HOME=/var/lib/yachiyo`.
For example, `sudo -u yachiyo env YACHIYO_HOME=/var/lib/yachiyo /opt/yachiyo/yachiyo chat`.
To store the key outside the data directory, add
`LoadCredential=yachiyo-master-key:/etc/yachiyo/master.key` to the unit and provide the same
key to offline configuration commands through `YACHIYO_MASTER_KEY_FILE`.

## Available tools

Chat, files, shell jobs, worker subagents, memory, the JS REPL, direct HTTP page reading,
schedules, and channels use the shared runtime. The Python REPL requires a previously
provisioned Yachiyo managed Python environment; this host does not expose its installer.
`useBrowser`, `webSearch`, `renderUi`, and the
desktop pairing-QR tool are omitted. Headless uses Node's TLS trust configuration for HTTP.

Core skill files ship in `/opt/yachiyo/core-skills` but are not auto-enabled. Copy compatible
skills into `$YACHIYO_HOME/skills/custom` and enable their names through `config set skills.enabled`.
Skills that require desktop apps, native notifications, or a graphical browser still need
those facilities. Update the installation and restart systemd to upgrade; desktop auto-update
commands do not apply.

## Verification

```sh
pnpm test:headless
pnpm test:remote
pnpm typecheck
pnpm lint
```

Headless integration tests run the real sockets, runtime, and Remote protocol against an
in-memory database and scripted model. Debian's native SQLite bindings and live provider
credentials must additionally be checked on the deployment host.
