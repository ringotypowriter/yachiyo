---
name: yachiyo-docs
description: Use when the user asks how Yachiyo itself works — what a feature does, what a setting changes, how to set up providers, skills, workspaces, channels, schedules, memory, or sync, where files live, or "what can you do". Reads the official documentation at yachiyo.ringo.sh so answers come from the current docs instead of memory.
license: Original clean-room skill for Yachiyo. No third-party skill content included.
---

# Yachiyo Docs

The official documentation is published at `https://yachiyo.ringo.sh/docs/` and
mirrored as plain text for machine reading. Use it to answer questions about how
Yachiyo works, rather than answering from memory.

**Read before answering.** Your training data does not contain this product, and
features change between releases. An answer invented from plausible-sounding
defaults is worse than one sentence saying you checked and the docs do not cover
it.

## Which skill

| Question                                                        | Skill          |
| --------------------------------------------------------------- | -------------- |
| A `yachiyo` CLI command, its flags, its JSON payload            | `yachiyo-help` |
| `yachiyo: command not found`, launch on login                   | `yachiyo-help` |
| What a feature is, what a setting does, how to set something up | this skill     |
| Where files live, what syncs, what leaves the machine           | this skill     |
| "What can you actually do?"                                     | this skill     |

`yachiyo-help` is local and works offline. This skill needs the network.

## Spend the smallest amount of context

Never open `llms-full.txt` as a first move. Start narrow and widen only if the
answer is not there.

| Source                                                 | Size   | Use for                                     |
| ------------------------------------------------------ | ------ | ------------------------------------------- |
| A single page from the table below                     | ~5 KB  | You already know the topic. Prefer this.    |
| `https://yachiyo.ringo.sh/llms.txt`                    | 1.4 KB | Index. Use when unsure where a topic lives. |
| `https://yachiyo.ringo.sh/_llms-txt/guides.txt`        | 46 KB  | A question spanning several guides          |
| `https://yachiyo.ringo.sh/_llms-txt/cli-reference.txt` | 25 KB  | The whole CLI surface at once               |
| `https://yachiyo.ringo.sh/llms-small.txt`              | 118 KB | Broad question, whole product               |
| `https://yachiyo.ringo.sh/llms-full.txt`               | 143 KB | Last resort                                 |

Fetch with `webRead`. One targeted page usually answers the question.

## Pages

| Topic                                               | URL                                |
| --------------------------------------------------- | ---------------------------------- |
| Overview, what it is                                | `/docs/`                           |
| Install, updating, building from source             | `/docs/install/`                   |
| First 15 minutes                                    | `/docs/quickstart/`                |
| Threads, runs, run modes, tools, Things, vocabulary | `/docs/concepts/`                  |
| Providers, models, tool model, reasoning effort     | `/docs/guides/providers/`          |
| Skills — discovery, writing, debugging              | `/docs/guides/skills/`             |
| Workspaces, file snapshots, diffs                   | `/docs/guides/workspace/`          |
| Memory, `SOUL.md`, `USER.md`                        | `/docs/guides/memory-and-persona/` |
| Subagents and delegation                            | `/docs/guides/coding-agents/`      |
| Scheduled runs, cron, result reporting              | `/docs/guides/schedules/`          |
| Telegram / QQ / Discord, guests, group mode         | `/docs/guides/channels/`           |
| Web search, page reading, browser session           | `/docs/guides/web-search/`         |
| Sync between machines, conflicts                    | `/docs/guides/sync/`               |
| Every `config.toml` key                             | `/docs/reference/config-toml/`     |
| Every `channels.toml` key                           | `/docs/reference/channels-toml/`   |
| What lives under `~/.yachiyo`, backups              | `/docs/reference/paths/`           |
| Common questions, what Yachiyo deliberately lacks   | `/docs/reference/faq/`             |

Prefix each with `https://yachiyo.ringo.sh`. Every CLI namespace also has a page
at `/docs/cli/<namespace>/`, but prefer `yachiyo-help` for those.

## Answering

- Answer in the user's language. The machine-readable text is English only;
  translate the answer rather than making the user read English.
- When linking a human to a page, give the localized URL if they are writing in
  Chinese: `/zh/docs/...` instead of `/docs/...`. Both exist.
- Prefer doing the thing over describing it. If the docs explain a setup the
  user wants, and you can perform it, offer to — you have shell access and the
  `yachiyo` CLI. Do not read a procedure aloud when you could run it.
- Say when the docs do not cover something, and do not fill the gap by
  guessing. Point at the repository instead:
  `https://github.com/ringotypowriter/yachiyo`.

## If the fetch fails

Say the docs could not be reached, answer only what you are actually sure of,
and mark it as unverified. Offline is a normal state for a local-first app — it
is not a reason to start inventing behaviour.
