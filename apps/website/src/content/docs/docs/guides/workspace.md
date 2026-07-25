---
title: Workspaces and files
description: Give threads a directory to work in, and review every file the agent changed with run snapshots.
---

A **workspace** is the directory a thread operates in. Relative paths in tool
calls resolve from it, and file writes stay inside it unless the agent uses an
absolute path.

Without a workspace, Yachiyo is a chat box. With one, it can read your project,
edit files, run commands, and show you what it changed.

## Registering workspaces

**Settings → Capabilities → Workspace** holds your saved paths. Each can carry a
label, which is what the agent sees when choosing between several available
workspaces — so "client-api (Go backend)" is more useful than a bare path.

The same pane sets which apps Yachiyo opens things with: an editor, a terminal,
and a Markdown viewer.

Threads that never get a workspace assigned get a temporary one under
`~/.yachiyo/temp-workspace/<thread-id>` instead, so tool calls always have
somewhere to land.

## Snapshots and diffs

Every run that touches files is snapshotted. Afterwards the run shows a diff of
what actually changed — not a summary the model wrote about what it thinks it
did.

Capture happens in three layers, because agents modify files in more ways than
one:

1. **Before a write** — the `write`, `edit`, and `applyPatch` tools capture the
   original content before replacing it.
2. **Around shell commands** — `bash` commands are parsed for likely write
   targets (redirects, `tee`, `sed -i`, and friends) and those files are captured
   too. This pass is deliberately imprecise.
3. **After the run** — the workspace is rescanned to catch whatever the first two
   layers missed.

Snapshots go into a content-addressed store, so unchanged files cost nothing and
repeated content is stored once. Old snapshots are garbage-collected in the
background.

The workspace scan skips the directories you would expect — `node_modules`,
`.git`, `dist`, `build`, `.next`, `.cache`, `__pycache__`, and `.yachiyo` — and
does not descend indefinitely. Shared system temp directories are never scanned
as external targets.

:::note
Snapshots are a review aid, not a backup system and not version control. For
work that matters, the agent operating inside a git repository is still the real
safety net.
:::

## Keeping edits inside the lines

Three things bound what the agent can do to your files:

- **The run mode.** In Explore mode the editing tools are not in the model's tool
  list at all. See [run modes](/docs/concepts/#run-modes).
- **The workspace boundary.** Relative paths resolve inside the workspace;
  reaching outside requires an explicit absolute path.
- **Read-before-write.** The `edit` and `write` tools require the file to have
  been read first, so the agent cannot blind-overwrite something it never looked
  at.

## Housekeeping

Temporary workspaces from runs that never wrote anything pile up over time.
**Settings → Capabilities → Workspace** has a prune action that deletes the empty
ones. It does not touch workspaces with files in them.
