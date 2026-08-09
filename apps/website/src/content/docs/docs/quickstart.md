---
title: Quickstart
description: Connect a provider, send your first message, and try the parts of Yachiyo that are not just chat.
---

This walks through the first fifteen minutes: getting a model connected, seeing
what the agent actually does, and knowing where to go next. It assumes Yachiyo
is [installed](/docs/install/) and running.

## 1. Connect a provider

On first launch, an onboarding overlay asks for three things in order:

1. **Provider** — pick one of the built-in presets (Anthropic, OpenAI, Gemini,
   DeepSeek, Moonshot, OpenRouter, Ollama, and a dozen more). The preset fills in
   the API type and base URL for you.
2. **API key** — paste it. It is encrypted in this device's provider credential
   vault and is not synced.
3. **Model** — choose the one new chats should start with.

If you skipped the overlay, the same thing lives in **Settings → Providers**.
From the CLI:

```bash
yachiyo provider list
yachiyo provider models anthropic       # what the API offers
yachiyo provider set-default anthropic --model <model-name>
```

Running a local model? Pick the **Ollama** preset — it points at
`http://localhost:11434/v1` and needs no key.

## 2. Send a message

Open a new thread and type. A few things worth noticing on that first exchange:

- The thread title writes itself once the first reply lands.
- The model picker in the composer switches models **per message**, not per app.
  Draft with a cheap model, escalate one question to a big one.
- While a reply is streaming you can keep typing. Whether Enter steers the
  running reply or queues a follow-up is set in **Settings → General →
  Behavior**.

## 3. Give it a workspace

Chat is the boring half. Yachiyo becomes useful when it has a directory to work
in.

Open **Settings → Capabilities → Workspace** and add a folder — a project repo,
a notes directory, a scratch folder. Then attach that workspace to a thread and
ask for something concrete:

> Look at the CSVs in this folder and tell me which ones have inconsistent
> column names.

The agent can read, edit, search, run shell commands, and browse the web. Every
file it modifies is snapshotted, so the run has a diff you can review afterwards
instead of a promise that it did the right thing.

See [Workspaces and files](/docs/guides/workspace/).

## 4. Try a skill

Skills are Markdown instructions the agent pulls in on demand. Yachiyo ships
with a set of them — browser automation, PDF/DOCX/XLSX handling, Zotero,
terminal control, and `yachiyo-help`, which teaches the agent its own CLI.

Ask it something that needs one:

> What can you actually do? Check your help skill first.

Enable or disable individual skills in **Settings → Capabilities → Skills**.
Writing your own is a `SKILL.md` file in a directory — see
[Skills](/docs/guides/skills/).

## 5. Stop configuring it by hand

This is the habit worth forming early, and the one most people are slowest to
pick up.

Yachiyo ships with `yachiyo-help` enabled — a skill documenting its own CLI,
config file, and setup procedures — and it has shell access to your machine. It
can therefore administer itself. Things you never need to do manually:

| Instead of                           | Say                                                             |
| ------------------------------------ | --------------------------------------------------------------- |
| Writing a LaunchAgent plist          | "Start yourself when I log in."                                 |
| Fixing your `PATH` by hand           | "The `yachiyo` command isn't found. Fix it."                    |
| Composing a schedule JSON payload    | "Every weekday at 8, check my inbox notes and summarize."       |
| Hunting through provider model lists | "What models can I use from OpenAI? Enable the three cheapest." |
| Writing a `SKILL.md` from scratch    | "Make me a skill for drafting release notes."                   |
| Reading the docs for a setting       | "What does the tool model do, and what should mine be?"         |

The manual paths all still exist, and this documentation keeps them — you should
be able to see exactly what is happening on your own machine. But the docs are
mostly a reference for _when something breaks_ or when you want it in a script.
The default interface is a sentence.

## 6. Point it at the world

Once the basics work, the pieces that make Yachiyo a resident rather than a tab:

- **[Schedules](/docs/guides/schedules/)** — run a prompt on a cron expression or
  at a specific time. Morning digests, nightly checks, one-off reminders.
- **[Channels](/docs/guides/channels/)** — connect Telegram, Discord, or QQ so
  the same assistant, with the same memory, answers from your phone.
- **[Coding agents](/docs/guides/coding-agents/)** — hand implementation work to
  Claude Code or Codex over ACP and get the result back in the thread.
- **[Memory and persona](/docs/guides/memory-and-persona/)** — `SOUL.md` and
  `USER.md` shape how it behaves across every thread and channel.

## Where your data is

| What                        | Where                                                    |
| --------------------------- | -------------------------------------------------------- |
| Settings and provider setup | `~/.yachiyo/config.toml`                                 |
| Model-provider credentials  | `~/.yachiyo/provider-credentials.enc` (encrypted, local) |
| Bot tokens                  | `~/.yachiyo/channels.toml`                               |
| Threads and messages        | `~/.yachiyo/yachiyo.sqlite`                              |
| Persona and profile         | `~/.yachiyo/SOUL.md`, `~/.yachiyo/USER.md`               |
| Skills                      | `~/.yachiyo/skills/`                                     |

No hosted backend, no telemetry. The only network calls are to the providers you
configured and the pages you ask it to read.
