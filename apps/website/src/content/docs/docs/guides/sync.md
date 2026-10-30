---
title: Sync
description: Share settings, custom skills, and chat archives through a folder you control — iCloud Drive, OneDrive, or anywhere else.
---

Sync moves three things between your devices: your **settings**, your **custom
skills**, and your **chat archives**. It works through a plain folder, so there
is no Yachiyo account and no server in the middle. Yachiyo recommends iCloud
Drive on macOS and OneDrive on Windows, but any folder you keep in sync yourself
works the same way.

Set it up in **Settings → Sync**.

## Enabling it

1. Choose a folder — use the recommended synced folder for the current platform,
   or **Choose Folder** to pick your own. The defaults are iCloud Drive on macOS
   and `<OneDrive>\Yachiyo\Sync` on Windows.
2. Hit **Enable Sync**.

On a second device, the pane offers **Join This Device** instead, because sync is
already initialized in that folder. Joining pulls the existing archives down.

If the recommended folder is unavailable, sign in to iCloud Drive on macOS or
OneDrive on Windows. Yachiyo does not invent a path when the service is absent;
choose any folder managed by another sync provider instead.

## What syncs, and what it costs you

**Settings** and files under `skills/custom/` sync bidirectionally. A custom
skill includes its whole directory — `SKILL.md`, references, assets, binaries,
and scripts. Generated dependency and version-control trees (`node_modules` and
`.git`), `.DS_Store`, and symbolic links are excluded. Bundled `skills/core/`
content is installed with the app and does not sync.

**Provider API keys and Vertex private keys** sync as encrypted snapshots. Joined
devices automatically exchange public keys and agree encryption keys. No sync
password or separate credential import is needed. Received credentials go into
the receiving device's local vault; they stay out of `config.toml`.

Both devices must support encrypted credential sync. When a device first joins,
an existing device needs to sync again after receiving its public key. Background
sync handles this exchange as the shared folder delivers the files. A device
that already received the credentials can also pass them to another joined
device while the original source is offline.

**Chat archives** from other devices arrive **read-only** — you can read a
conversation that started on your laptop from your desktop, but you cannot
continue it there. Threads stay owned by the device that created them.

Sync runs on its own: a debounced push after changes and a periodic pull, with a
single-flight lock so two passes never overlap. **Sync Now** forces a pass when
you do not want to wait.

## Conflicts

Two devices editing the same setting or custom-skill file produce a conflict,
and Yachiyo does not guess. **Settings → Sync → Conflicts** lists each one.
Settings conflicts include the fields that differ; skill conflicts identify the
file and the hashes of both versions.

Edits to different existing providers merge automatically when both devices share
the same provider list. A choice for one provider does not discard changes to
another. Adding, removing, renaming, or reordering providers still treats the list
as one setting when checking conflicts.

Credential updates and deletions carry versions so old files cannot restore an
older key. If two devices change the same credential while offline, they choose
the same version using a deterministic order.

- **Keep This Device** — your local value wins.
- **Use Synced Version** — replaces this device's setting or skill file with the
  synced one. This is confirmed before it applies, because it is destructive.
- **Copy Synced Data** — grab the incoming version to inspect by hand.

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
| **Sync folder unavailable**    | The selected folder cannot be reached          |

It also shows the device count and how many conflicts are pending.

:::caution[Keep the sync folder private]
Provider credentials are encrypted in the sync folder. Access to that folder
establishes trust when a device first joins; previously seen device keys are
pinned, and an unexpected key change stops credential exchange. Do not grant
other people write access to this folder. Settings sync still copies `config.toml`,
which can contain an Exa web-search API key. Do not use a shared team drive or a
public link. Custom skills are copied as a full
tree, including script contents, so remove hard-coded keys before enabling sync.
:::
