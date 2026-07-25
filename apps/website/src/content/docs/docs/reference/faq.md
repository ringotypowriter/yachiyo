---
title: FAQ
description: Common questions about platforms, providers, privacy, skills, and what Yachiyo deliberately does not do.
---

## Do I have to configure all this by hand?

No, and mostly you should not. Yachiyo ships with the `yachiyo-help` skill
enabled — documentation of its own CLI, config, and setup procedures — plus shell
access. So it can administer itself: set up launch-on-login, repair your `PATH`,
create a schedule, curate a model list, write a skill.

Ask in plain language and check what it did. These docs exist for when something
breaks, when you want the underlying detail, or when you need it scripted.

## Is there a Windows or Linux build?

No, and none is planned. Yachiyo is built on a Mac and there is no hardware here
to test the other platforms on, so porting it is not on the table. Several
bundled skills — window automation, Ghostty control, screenshots — are macOS-only
regardless.

## Does Yachiyo support MCP?

No, deliberately. Skills are Markdown files instead: no protocol, no server
process, no manifest. If you can write a README you can extend Yachiyo. That is
the whole trade — you give up an ecosystem's worth of prebuilt integrations and
get something you can read, edit, and reason about.

## Where is my data?

`~/.yachiyo`, on your machine. Conversations are in a local SQLite database.
There is no hosted backend and no account. See
[Files and paths](/docs/reference/paths/).

## Is there telemetry?

No.

## Can I use a local model?

Yes. The **Ollama** preset points at `http://localhost:11434/v1` and needs no key.
Any OpenAI-compatible server works the same way. See
[Providers](/docs/guides/providers/).

## Can I use several providers at once?

Yes, and it is the expected setup. Model choice is per message, not per app —
draft with something cheap, escalate the hard question, keep the whole exchange
in one thread.

## Do I have to pick one model for everything?

No. There is a chat model and a separate [tool model](/docs/guides/providers/#the-tool-model)
for background work like thread titles and memory distillation. Pointing the tool
model at something small and fast is the usual setup.

## Do my Claude Code / Codex skills work?

Yes. Yachiyo scans `~/.claude/skills`, `~/.codex/skills`, and `~/.agents/skills`
alongside its own, in both your home directory and each registered workspace.
They are discovered but not auto-enabled — switch them on in **Settings →
Capabilities → Skills**.

## Why did my edit to a bundled skill disappear?

`~/.yachiyo/skills/core/` is re-extracted on every app launch. Put your own work
in `~/.yachiyo/skills/custom/` instead.

## Do schedules run when the app is closed?

No. Schedules, channel bots, and `yachiyo send` all need the app running. Set up
a [LaunchAgent](/docs/install/#launch-on-login) if you want it always on.

## Can other people use my assistant through Telegram?

Only if you let them. Users register on first contact as `pending` and stay
blocked until you allow them. Guests get a sandboxed workspace, filtered memory,
their own profile, and a token quota. See [Channels](/docs/guides/channels/).

## Will the bot reply to everything in a group chat?

No. Group mode runs a cheap probe model that watches the conversation and only
wakes the full model when there is something worth saying, backing off through
dormant, active, and engaged phases. See
[group discussion mode](/docs/guides/channels/#group-discussion-mode).

## Can I stop it from editing files?

Yes. Use **Explore** or **Chat** [run mode](/docs/concepts/#run-modes), which
removes the editing tools from the model's tool list entirely, or just do not
give the thread a workspace. Every run that does touch files leaves a reviewable
diff.

## Are my API keys safe?

They are stored in plain text in `config.toml`, on your machine. CLI output
redacts them, but the file does not encrypt them. Do not commit it, and be aware
that enabling [sync](/docs/guides/sync/) copies it into your sync folder.

Channel bot tokens in `channels.toml` are not redacted in output at all.

## What happens when a conversation gets too long?

Older context is compacted rather than dropped — a handoff summary preserves the
thread's substance while freeing the window. The threshold is configurable via
`chat.stripCompactThresholdTokens`.

## Can I search old conversations?

Yes, in the app or from the CLI. The full-text index is trigram-based, so it
handles CJK as well as English:

```bash
yachiyo thread search "that thing about retries" --limit 10
```

## Does sync mean I can chat from any device?

Partly. Settings sync both ways, but chat archives from other devices arrive
**read-only** — you can read a laptop conversation on your desktop, not continue
it there.

## Can I contribute?

Bug fixes and documentation improvements are welcome. Feature PRs are not
accepted unless the feature was discussed and approved in an issue first — open
the issue before writing code. See the
[repository](https://github.com/ringotypowriter/yachiyo).
