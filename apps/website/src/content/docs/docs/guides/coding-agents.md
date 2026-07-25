---
title: Subagents and coding agents
description: Delegate work to built-in worker subagents or hand implementation tasks to Claude Code and Codex over ACP.
---

Some work does not belong in the main conversation — a wide codebase search that
would flood the context window, or a multi-file refactor that deserves its own
agent. The `delegateTask` tool hands that work off and brings back the result.

There are two delegation backends, and you pick one globally.

## Worker mode (default)

Yachiyo runs the subagent itself, using your configured provider. Four named
agents, each with a fixed role:

| Agent       | Use it for                                                                                                                                 |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| **Explore** | Finding files, searching patterns, understanding how something works. Read-only. Run several in parallel when the modules are independent. |
| **Plan**    | A step-by-step strategy for a complex multi-file change, with the critical files identified.                                               |
| **Review**  | A second opinion on uncommitted changes before you commit.                                                                                 |
| **General** | Editing, running commands, anything the read-only agents cannot do. The fallback.                                                          |

All four are enabled by default. Which ones are available is set in **Settings →
Capabilities → Coding agents**.

:::note[Subagents start blank]
A worker subagent sees only its system prompt and the prompt it is handed — not
your conversation, not the plan document, not earlier tool results. The task
brief has to be self-contained, with explicit file paths and done criteria.

This is why "continue with the plan above" fails and "implement the retry logic
in `src/net/client.ts:120`, keeping the existing backoff constants" works.
:::

Each worker can run on its own model — **Settings → Capabilities → Coding
agents** has a model selector per worker, defaulting to whatever model is making
the call. Read-heavy Explore work on a cheap model while the main conversation
stays on a strong one is the obvious use.

## ACP mode (deprecated)

The other backend hands the task to an external coding agent over the
[Agent Client Protocol](https://agentclientprotocol.com/) — Claude Code, Codex,
or anything else speaking ACP. The agent runs as its own process with its own
model and context, then reports back into the thread.

:::caution[Deprecated]
ACP mode is deprecated. Existing profiles keep working for compatibility, but
worker mode is where the development is. Do not build new setups on it.
:::

One profile ships preconfigured for it:

| Field     | Value                                        |
| --------- | -------------------------------------------- |
| `name`    | Claude Code                                  |
| `command` | `npx`                                        |
| `args`    | `["-y", "@zed-industries/claude-agent-acp"]` |
| `env`     | `{ "ACP_PERMISSION_MODE": "acceptEdits" }`   |

In ACP mode, `delegateTask` is unavailable unless the workspace is a git
repository. An external agent editing files with no way to diff or revert is not
a trade worth making, so the tool refuses rather than degrading quietly.

## Switching modes and managing profiles

```bash
yachiyo agent mode worker      # or: acp
yachiyo agent list             # current mode, plus any ACP profiles
```

ACP profiles take these fields:

| Field         | Type                    | Notes                                                |
| ------------- | ----------------------- | ---------------------------------------------------- |
| `id`          | `string`                | Auto-generated on add                                |
| `name`        | `string`                | Display name                                         |
| `enabled`     | `boolean`               | Disabled profiles stay in config but are not offered |
| `description` | `string`                | Shown in the UI                                      |
| `command`     | `string`                | Executable — `npx`, `node`, an absolute path         |
| `args`        | `string[]`              | Arguments                                            |
| `env`         | `Record<string,string>` | Extra environment variables                          |

Full details in the [`agent` CLI reference](/docs/cli/agent/).

## Or skip delegation

Delegation is a judgement call, not a setting. For small, well-scoped changes the
main agent doing the work itself is often faster than writing a task brief good
enough for an agent that cannot see your conversation — so just ask for the
change directly. If you want the boundary enforced rather than implied, Explore
and Chat [run modes](/docs/concepts/#run-modes) drop `delegateTask` from the tool
list entirely.
