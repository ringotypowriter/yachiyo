---
title: Sync
description: Share settings and chat archives between your machines through a folder you control — iCloud Drive or anywhere else.
---

Sync moves two things between your devices: your **settings** and your **chat
archives**. It works through a plain folder, so there is no Yachiyo account and
no server in the middle. iCloud Drive is the recommended folder because macOS
already syncs it, but any folder you keep in sync yourself works the same way.

Set it up in **Settings → Sync**.

## Enabling it

1. Choose a folder — **Use iCloud Folder** for the recommended location, or
   **Choose Folder** to pick your own.
2. Hit **Enable Sync**.

On a second device, the pane offers **Join This Device** instead, because sync is
already initialized in that folder. Joining pulls the existing archives down.

If the recommended iCloud folder is unavailable, macOS is usually the reason:
sign in to iCloud Drive and turn on Documents sync, or point Yachiyo at a folder
you manage yourself.

## What syncs, and what it costs you

**Settings** sync bidirectionally. **Chat archives** from other devices arrive
**read-only** — you can read a conversation that started on your laptop from your
desktop, but you cannot continue it there. Threads stay owned by the device that
created them.

Sync runs on its own: a debounced push after changes and a periodic pull, with a
single-flight lock so two passes never overlap. **Sync Now** forces a pass when
you do not want to wait.

## Conflicts

Two devices editing the same setting produce a conflict, and Yachiyo does not
guess. **Settings → Sync → Conflicts** lists each one with the fields that
differ, a hash of each version, and per-field resolution:

- **Keep This Device** — your local value wins.
- **Use Synced Version** — replaces this device's settings with the synced one.
  This is confirmed before it applies, because it is destructive.
- **Copy Synced TOML** — grab the incoming version to inspect by hand.

Once you resolve a conflict, that exact pair of versions is remembered, so the
same disagreement is not raised at you again on every subsequent pass.

## Status

The pane reports one of:

| Status                         | Meaning                                        |
| ------------------------------ | ---------------------------------------------- |
| **Ready**                      | Sync is working                                |
| **Not enabled on this device** | The folder has sync in it; join to participate |
| **Not initialized**            | No sync set up in this folder yet              |
| **Needs attention**            | Conflicts are waiting for you                  |
| **Sync folder unavailable**    | The folder cannot be reached — usually iCloud  |

It also shows the device count and how many conflicts are pending.

:::caution[Your sync folder holds your API keys]
Settings sync includes `config.toml`, which contains provider API keys in plain
text. Use a private folder — not a shared team drive, not a public Dropbox link.
:::
