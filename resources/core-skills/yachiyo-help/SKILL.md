---
name: yachiyo-help
description: Complete reference for the Yachiyo CLI — soul traits, provider management, config, and usage guide
---

# Yachiyo Help

Complete guide to using the Yachiyo CLI. The `yachiyo` binary is installed at `~/.yachiyo/bin/yachiyo` when you first launch the app.

## Usage

```
yachiyo <namespace> <subcommand> [args...] [flags...]
```

## Namespaces & Subcommands

- `soul` — Manage evolving persona traits
- `provider` — Manage AI providers
- `agent` — Manage coding agent profiles
- `config` — Read and write configuration values
- `thread` — Search historical conversations

### `soul traits` — Manage evolving persona traits

The SOUL document (`~/.yachiyo/SOUL.md`) defines the assistant's personality and behavioral tendencies. The `traits` section holds a list of evolving observations that build up over time.

```
yachiyo soul traits list
```

Print all current soul traits as JSON (index + text pairs).

```
yachiyo soul traits add "<trait text>"
```

Append a new trait. The text is stored under today's date heading inside SOUL.md.

```
yachiyo soul traits remove <index-or-text>
```

Remove a trait by its numeric index (from `list`) or by matching text substring.

---

### `provider` — Manage AI providers

```
yachiyo provider list
```

List all configured providers (API keys redacted as `***`).

```
yachiyo provider show <id-or-name>
```

Show full details of one provider by its ID or display name.

```
yachiyo provider update <id-or-name> [--payload <json>]
```

Patch a provider's fields using a JSON object. Example:

```
yachiyo provider update my-openai --payload '{"apiKey":"sk-..."}'
```

```
yachiyo provider set-default <id-or-name>
```

Move the specified provider to the top of the list, making it the default for new chats.

```
yachiyo provider models <id-or-name>
```

Fetch and list available models for the specified provider.

---

### `agent` — Manage coding agent profiles

Coding agent profiles (`subagentProfiles` in `config.toml`) define external agents that Yachiyo can launch for coding tasks. Each profile specifies the agent binary, its arguments, and environment variables.

```
yachiyo agent list
```

List all configured agent profiles as JSON.

```
yachiyo agent show <id-or-name>
```

Show a single agent profile by its `id` or display `name`.

```
yachiyo agent add --payload <json>
```

Create a new agent profile. The payload must include at minimum `name` and `command`. An `id` is auto-generated if not supplied. All other fields default to safe values (`enabled: true`, `args: []`, `env: {}`). Example:

```
yachiyo agent add --payload '{"name":"My Agent","command":"npx","args":["-y","my-agent-package"],"env":{"MODE":"prod"}}'
```

```
yachiyo agent update <id-or-name> [--payload <json>]
```

Patch an existing agent profile. Only supplied fields are changed; the `id` is always preserved. Example:

```
yachiyo agent update my-agent --payload '{"description":"Updated description","args":["-y","my-agent@latest"]}'
```

```
yachiyo agent remove <id-or-name>
```

Permanently delete an agent profile from config.

```
yachiyo agent enable <id-or-name>
yachiyo agent disable <id-or-name>
```

Toggle an agent profile on or off without deleting it. Disabled profiles are kept in config but will not be offered to the user. This is the preferred way to temporarily suppress an agent.

**Profile fields:**

| Field         | Type                    | Description                                      |
| ------------- | ----------------------- | ------------------------------------------------ |
| `id`          | `string`                | Stable unique identifier (auto-generated on add) |
| `name`        | `string`                | Human-readable display name                      |
| `enabled`     | `boolean`               | Whether the profile is active                    |
| `description` | `string`                | Short description shown in the UI                |
| `command`     | `string`                | Executable to launch (e.g. `npx`, `node`)        |
| `args`        | `string[]`              | Arguments passed to the command                  |
| `env`         | `Record<string,string>` | Extra environment variables for the process      |

---

### `thread` — Search historical conversations

```
yachiyo thread search <query> [--limit <n>] [--json]
```

Search all non-archived threads and messages for `<query>` using substring matching (case-insensitive LIKE). Results are pulled directly from the local SQLite database — no running daemon required.

**Default output** (plain text, optimised for LLM consumption):

```
[ThreadID: abc123] 2024-03-15 Role: user Content: …found the relevant text here…
[ThreadID: def456] 2024-03-10 Role: model Content: …here is what I suggested…
```

**Flags:**

| Flag          | Default | Description                                      |
| ------------- | ------- | ------------------------------------------------ |
| `--limit <n>` | `5`     | Maximum number of matching messages to return    |
| `--json`      | off     | Output a raw JSON array for programmatic parsing |

**Examples:**

```
yachiyo thread search "deployment steps"
yachiyo thread search "api key" --limit 10
yachiyo thread search "auth" --json
```

The `--db` flag overrides the database path if you use an isolated `YACHIYO_HOME` workspace.

---

### `config` — Read and write configuration values

Configuration is stored at `~/.yachiyo/config.toml`. All values are accessible via dot-separated paths.

```
yachiyo config get [path]
```

Print the full config as JSON, or a nested value at `path`. Examples:

```
yachiyo config get
yachiyo config get skills.enabled
yachiyo config get providers.0.name
```

```
yachiyo config set <path> <value>
```

Set a config value. The value is parsed as JSON if possible, otherwise treated as a string. Examples:

```
yachiyo config set skills.enabled '["yachiyo-help","my-style"]'
yachiyo config set chat.activeRunEnterBehavior '"enter-queues-follow-up"'
```

---

## Flags

| Flag                | Description                                                         |
| ------------------- | ------------------------------------------------------------------- |
| `--settings <path>` | Override the settings file path (default: `~/.yachiyo/config.toml`) |
| `--soul <path>`     | Override the SOUL document path (default: `~/.yachiyo/SOUL.md`)     |
| `--db <path>`       | Override the database path (default: `~/.yachiyo/yachiyo.sqlite`)   |
| `--payload <json>`  | Supply a JSON body for mutation commands (e.g. `provider update`)   |
| `--limit <n>`       | Max results for `thread search` (default: `5`)                      |
| `--json`            | Output raw JSON for `thread search`                                 |

---

## Key Files & Directories

| Path                        | Purpose                                                    |
| --------------------------- | ---------------------------------------------------------- |
| `~/.yachiyo/config.toml`    | All settings: providers, tools, skills, memory, web search |
| `~/.yachiyo/SOUL.md`        | Assistant persona and evolving trait log                   |
| `~/.yachiyo/USER.md`        | User profile — who you are, your context, working style    |
| `~/.yachiyo/skills/core/`   | Built-in skills (auto-extracted and updated by the app)    |
| `~/.yachiyo/skills/custom/` | Your own skills — never touched by the app                 |
| `~/.yachiyo/yachiyo.sqlite` | Thread and message database                                |
| `~/.yachiyo/bin/yachiyo`    | Auto-generated CLI wrapper                                 |

---

## Skills System

Skills are Markdown documents (SKILL.md) that provide context, guidelines, or reference material to the assistant. They are loaded per-thread when enabled.

**Discovery roots** (searched recursively for `SKILL.md`):

- `~/.yachiyo/skills/`
- `~/.codex/skills/`, `~/.agents/skills/`, `~/.claude/skills/`
- `<workspace>/.yachiyo/skills/`, `<workspace>/.codex/skills/`, etc.

**Enable/disable skills via config:**

```
yachiyo config set skills.enabled '["yachiyo-help", "my-skill"]'
```

**SKILL.md format:**

```markdown
---
name: my-skill
description: What this skill does
---

# My Skill

Skill content goes here. This is injected into the assistant context
when the skill is active.
```

Core skills (this directory) are extracted to `~/.yachiyo/skills/core/` on each app launch and enabled by default. Custom skills go in `~/.yachiyo/skills/custom/` — that directory is never modified by the app.

---

## Environment Variables

| Variable       | Description                                                      |
| -------------- | ---------------------------------------------------------------- |
| `YACHIYO_HOME` | Override the `~/.yachiyo` data directory for isolated workspaces |
