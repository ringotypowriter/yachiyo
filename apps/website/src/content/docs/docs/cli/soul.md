---
title: yachiyo soul
description: List, add, and remove the evolving persona traits in SOUL.md.
---

`~/.yachiyo/SOUL.md` defines the assistant's personality. Its `traits` section
holds evolving observations that accumulate over time — this namespace edits
that list.

## `soul traits list`

```bash
yachiyo soul traits list
```

Prints all current traits as a JSON array of `{ key, trait }` pairs. The `key` is
a stable hash you pass to `remove`.

## `soul traits add`

```bash
yachiyo soul traits add "<trait text>"
```

Appends a trait, filed under today's date heading inside `SOUL.md`. Returns the
updated list.

```bash
yachiyo soul traits add "States the tradeoff before the recommendation"
```

## `soul traits remove`

```bash
yachiyo soul traits remove <key>
```

Removes a trait by its hash key — the `key` field from `soul traits list`, not a
position or the text itself. Returns the updated list.

## Using another soul file

```bash
yachiyo soul traits list --soul /path/to/SOUL.md
```

## See also

- [Memory and persona](/docs/guides/memory-and-persona/) — how `SOUL.md`,
  `USER.md`, and memory differ
