export const GLOBAL_FLAGS_HELP = `Global flags:
  --settings <path>   Settings file path      (default: ~/.yachiyo/config.toml)
  --soul <path>       Soul document path      (default: ~/.yachiyo/SOUL.md)
  --db <path>         Database file path       (default: ~/.yachiyo/yachiyo.sqlite)
  --payload <json>    JSON payload for mutation commands
  --limit <n>         Max results to return    (default: 5)
  --json              Output raw JSON instead of human-readable text
  --help              Show help for a command or namespace`

export const NAMESPACE_HELP: Record<string, string> = {
  soul: `Usage: yachiyo soul <subcommand> [args...]

  soul traits list                       List evolved personality traits (JSON array of {key, trait}).
  soul traits add <trait>                Append a daily trait. Returns updated list.
  soul traits remove <key>               Remove trait by hash key. Returns updated list.`,

  provider: `Usage: yachiyo provider <action> [args...] [flags...]

  provider list                          List all configured LLM providers (apiKey is redacted).
  provider show <id-or-name>             Show a single provider by UUID or display name.
  provider update <id-or-name> [--payload <json>]
                                         Merge JSON patch into an existing provider config.
  provider set-default <id-or-name> [--model <model>]
                                         Promote a provider to default and set the active model.
                                         Without --model, picks the first enabled model.
  provider models [id-or-name]           Without argument: list all locally enabled models.
                                         With argument: fetch available model IDs from the provider's API.`,

  agent: `Usage: yachiyo agent <action> [args...] [flags...]

  agent mode <worker|acp>                Set the subagent runtime mode. Worker is the default; ACP is deprecated.
  agent list                             Show current mode and deprecated ACP profiles.
  agent show <id-or-name>                Show a single deprecated ACP profile.
  agent add --payload <json>             Register a deprecated ACP agent. Requires "name" and "command" in payload.
  agent update <id-or-name> [--payload <json>]
                                         Merge JSON patch into an existing deprecated ACP profile.
  agent remove <id-or-name>              Unregister a deprecated ACP profile.
  agent enable <id-or-name>              Enable a disabled deprecated ACP profile.
  agent disable <id-or-name>             Disable a deprecated ACP profile without removing it.`,

  config: `Usage: yachiyo config <action> [args...]

  config get [path]                      Read the full settings object, or a dot-separated path (e.g. "providers.0.name").
  config set <path> <value>              Write a value at a dot-separated path. Value is parsed as JSON; plain strings are kept as-is.`,

  thread: `Usage: yachiyo thread <action> [args...] [flags...]

  thread search <query> [--limit <n>] [--json] [--include-private]
                                         Full-text search across message history. Default limit=5.
                                         Without --json, prints human-readable lines.
                                         Privacy-mode threads are hidden unless --include-private is set.
  thread list [--limit <n>] [--json] [--include-private]
                                         List recent (non-archived) threads ordered by updatedAt desc.
                                         Each entry includes the thread's first user query and preview.
                                         Default limit=10. Privacy-mode threads are hidden unless
                                         --include-private is set.
  thread show <id> [--json] [--include-private]
                                         Dump all messages of a thread in chronological order.
                                         Privacy-mode threads are hidden unless --include-private is set.`,

  schedule: `Usage: yachiyo schedule <action> [args...] [flags...]

  schedule list [--json]                 List all schedules. Without --json, prints a compact summary.
  schedule add --payload <json>          Create a new schedule. Payload must include name and prompt, plus either
                                         cronExpression (recurring) or runAt (ISO datetime, one-off).
  schedule update --payload <json>       Update fields on an existing schedule. Payload must include id; any of
                                         name, prompt, cronExpression, runAt, workspacePath, modelOverride,
                                         enabledTools, enabled may be supplied. Bundled schedules accept only
                                         enabled and cronExpression changes.
  schedule remove <id>                   Delete a schedule by UUID.
  schedule enable <id>                   Enable a disabled schedule.
  schedule disable <id>                  Disable a schedule without removing it.
  schedule runs [<id>] [--limit <n>] [--json]
                                         List recent schedule runs. Optionally filter by schedule UUID.`,

  channel: `Usage: yachiyo channel <action> [args...] [flags...]

  channel users [--json]                 List registered channel users with their IDs, platforms, and statuses.
                                         Use the "id" field with "send channel" to send a message.
                                         Without --json, prints a compact summary.
  channel users set-label <id> <label>   Set a descriptive label on a channel user.
                                         Labels help the agent identify who each contact is.
  channel groups [--json]                List registered channel groups with their IDs, platforms, and statuses.
                                         Use the "id" field with "send channel" to send a message.
                                         Without --json, prints a compact summary.
  channel groups set-status <id> <status>
                                         Update only a group channel's monitor status.
                                         Accepted statuses: approved|approval, pending, blocked|block.
  channel groups set-label <id> <label>  Set a descriptive label on a channel group.
                                         Labels help the agent understand the group's context.`,

  send: `Usage: yachiyo send <subcommand> [args...] [flags...]

  Requires the app to be running.
  If you are an agent running inside Yachiyo, the app is already running — these commands work directly.

  send notification <message> [--title <title>]
                                         Push a native OS notification. Default title="Yachiyo". Fire-and-forget.
  send channel <id> <message>            Send a text message directly to a channel user or group on their
                                         external platform (Telegram/QQ/Discord) as the bot. No thread or
                                         inference — the message goes straight out. Fire-and-forget.
                                         Get valid IDs from "channel users" or "channel groups".`
}

export function namespaceHelp(ns: string): string {
  return `${NAMESPACE_HELP[ns]}\n\n${GLOBAL_FLAGS_HELP}`
}

export const USAGE = `Usage: yachiyo <namespace> <subcommand> [args...] [flags...]

All output is JSON unless noted. The app must be running for "send" commands.
Use "yachiyo <namespace> --help" for detailed help on a specific namespace.

Namespaces: soul, provider, agent, config, thread, schedule, channel, send

${Object.values(NAMESPACE_HELP).join('\n\n')}\n\n${GLOBAL_FLAGS_HELP}`
