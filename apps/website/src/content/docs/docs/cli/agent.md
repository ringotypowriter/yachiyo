---
title: yachiyo agent
description: Switch the subagent runtime mode and manage legacy ACP agent profiles.
---

Controls how `delegateTask` runs work: in-process **worker** subagents (the
default) or external **ACP** agents (deprecated).

## `agent mode`

```bash
yachiyo agent mode worker
yachiyo agent mode acp
```

Sets the subagent runtime mode. Worker mode exposes Explore, Plan, Review, and
General through `delegateTask`. ACP mode routes to external agent processes and
is deprecated.

## `agent list`

```bash
yachiyo agent list
```

Shows the current mode along with any ACP profiles still configured.

## ACP profile commands

:::caution[Deprecated]
ACP agents are deprecated. Existing profiles keep working, but new setups should
use worker mode.
:::

```bash
yachiyo agent show <id-or-name>
yachiyo agent add --payload '<json>'
yachiyo agent update <id-or-name> [--payload '<json>']
yachiyo agent remove <id-or-name>
yachiyo agent enable <id-or-name>
yachiyo agent disable <id-or-name>
```

`add` requires at least `name` and `command`. An `id` is generated if you omit
one, and the rest default to safe values (`enabled: true`, `args: []`,
`env: {}`).

```bash
yachiyo agent add --payload '{
  "name": "My Agent",
  "command": "npx",
  "args": ["-y", "some-acp-agent"],
  "env": {"MODE": "prod"}
}'
```

`update` merges — only supplied fields change, and `id` is always preserved.

```bash
yachiyo agent update my-agent --payload '{"description":"Updated","args":["-y","some-acp-agent@latest"]}'
```

`disable` keeps the profile in config but stops offering it; `remove` deletes it
permanently.

## Profile fields

| Field         | Type                    | Description                                            |
| ------------- | ----------------------- | ------------------------------------------------------ |
| `id`          | `string`                | Stable identifier, auto-generated on add               |
| `name`        | `string`                | Display name                                           |
| `enabled`     | `boolean`               | Whether the profile is active                          |
| `description` | `string`                | Short description shown in the UI                      |
| `command`     | `string`                | Executable to launch (`npx`, `node`, an absolute path) |
| `args`        | `string[]`              | Arguments passed to the command                        |
| `env`         | `Record<string,string>` | Extra environment variables                            |

## See also

- [Subagents and coding agents](/docs/guides/coding-agents/)
