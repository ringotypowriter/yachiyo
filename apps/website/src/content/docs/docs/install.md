---
title: Install
description: Download Yachiyo, launch it for the first time, and get the yachiyo CLI on your PATH.
---

## Requirements

macOS only. There is no Windows or Linux build and none is planned.

You also need an API key for at least one model provider. Yachiyo does not ship
with a bundled model or a hosted account — see [Providers and
models](/docs/guides/providers/).

## Download

Grab the latest `.dmg` from the
[Releases page](https://github.com/ringotypowriter/yachiyo/releases), open it,
and drag **Yachiyo** into `/Applications`.

## First launch

On first launch Yachiyo creates its home directory at `~/.yachiyo` and populates
it with:

- `config.toml` — providers, tools, skills, memory, and web search settings
- `channels.toml` — Telegram / QQ / Discord credentials, kept separate from
  `config.toml` so bot tokens never mix with the rest of your settings
- `yachiyo.sqlite` — every thread and message, stored locally
- `skills/core/` — the bundled core skills, extracted fresh on each app update
- `bin/yachiyo` — the CLI wrapper

An onboarding overlay walks you through connecting a provider. If you would
rather do it yourself, head to [Quickstart](/docs/quickstart/).

:::note[Using a different home directory]
Set `YACHIYO_HOME` to point the whole data directory somewhere else. This is the
clean way to keep an isolated workspace for testing without touching your real
history.
:::

## The CLI

Every time the desktop app launches, it writes `~/.yachiyo/bin/yachiyo` and then
tries to make it reachable:

1. It symlinks `/usr/local/bin/yachiyo` to the wrapper. If that succeeds, the
   command works in any new shell immediately.
2. If the symlink cannot be created — `/usr/local/bin` is missing, unwritable, or
   already occupied by a real file — it appends `~/.yachiyo/bin` to your shell
   profile instead (zsh, bash, and fish are handled).

Either way you need a **new terminal session** before the command resolves.

Verify it:

```bash
yachiyo thread list --limit 3
```

If you get `command not found`, see
[the CLI overview](/docs/cli/#command-not-found) for the fix.

:::caution
The wrapper is regenerated on every launch and points at the app bundle you are
currently running. Do not edit it — your changes are overwritten the next time
Yachiyo starts.
:::

## Launch on login

Yachiyo has to be running for scheduled tasks, channel bots, and `yachiyo send`
to work. So ask it to arrange that:

> Make yourself start automatically when I log in.

It knows how — the bundled `yachiyo-help` skill carries the LaunchAgent recipe,
and it has shell access to write the file and load it. Ask it to check afterwards
and it will confirm the agent is registered.

This is the intended way to do almost anything mechanical here. You are not
configuring a tool; you are asking an assistant that can already read its own
documentation and act on your machine.

<details>
<summary>If you would rather do it by hand</summary>

Write the LaunchAgent:

```xml title="~/Library/LaunchAgents/sh.ringo.yachiyo.plist"
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>sh.ringo.yachiyo</string>
    <key>ProgramArguments</key>
    <array>
        <string>/usr/bin/open</string>
        <string>/Applications/Yachiyo.app</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
</dict>
</plist>
```

Then load and confirm it:

```bash
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/sh.ringo.yachiyo.plist
launchctl list | grep sh.ringo.yachiyo
```

</details>

## Updating

Download the new `.dmg` and replace the app in `/Applications`. Your
`~/.yachiyo` directory is untouched by updates — settings, history, and custom
skills all survive. Bundled core skills under `skills/core/` are re-extracted on
each launch, so local edits to those are not preserved; put your own work in
`skills/custom/` instead.

## Building from source

```bash
nvm use
pnpm install
pnpm dev
```

The repo is a pnpm workspace: `apps/desktop` (Electron app), `packages/runtime`
(the assistant runtime), `packages/cli`, `packages/shared`, and
`packages/core-skills`.
