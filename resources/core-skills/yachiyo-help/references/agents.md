# Agent Profiles — CLI Reference

Coding agent profiles (`subagentProfiles` in `config.toml`) define external agents that Yachiyo can launch for coding tasks. Each profile specifies the agent binary, its arguments, and environment variables.

## Commands

### List all profiles

```
yachiyo agent list
```

Returns all configured agent profiles as JSON.

### Show a profile

```
yachiyo agent show <id-or-name>
```

Show a single agent profile by its `id` or display `name`.

### Add a profile

```
yachiyo agent add --payload '<json>'
```

The payload must include at minimum `name` and `command`. An `id` is auto-generated if not supplied. All other fields default to safe values (`enabled: true`, `args: []`, `env: {}`).

```bash
yachiyo agent add --payload '{
  "name": "My Agent",
  "command": "npx",
  "args": ["-y", "my-agent-package"],
  "env": {"MODE": "prod"}
}'
```

### Update a profile

```
yachiyo agent update <id-or-name> [--payload '<json>']
```

Patch an existing profile. Only supplied fields are changed; the `id` is always preserved.

```bash
yachiyo agent update my-agent --payload '{"description":"Updated","args":["-y","my-agent@latest"]}'
```

### Remove a profile

```
yachiyo agent remove <id-or-name>
```

Permanently delete an agent profile from config.

### Enable / disable

```
yachiyo agent enable <id-or-name>
yachiyo agent disable <id-or-name>
```

Toggle on or off without deleting it. Disabled profiles are kept in config but will not be offered to the user.

## Profile Fields

| Field         | Type                    | Description                                      |
| ------------- | ----------------------- | ------------------------------------------------ |
| `id`          | `string`                | Stable unique identifier (auto-generated on add) |
| `name`        | `string`                | Human-readable display name                      |
| `enabled`     | `boolean`               | Whether the profile is active                    |
| `description` | `string`                | Short description shown in the UI                |
| `command`     | `string`                | Executable to launch (e.g. `npx`, `node`)        |
| `args`        | `string[]`              | Arguments passed to the command                  |
| `env`         | `Record<string,string>` | Extra environment variables for the process      |
