---
title: Core concepts
description: Threads, runs, run modes, workspaces, skills, memory, and channels — the vocabulary the rest of the docs assumes.
---

Yachiyo has maybe a dozen ideas in it. Learn these and the settings screens stop
being a maze.

## Threads and branching

A **thread** is a conversation. Unlike most chat apps, a thread is a _tree_, not
a list: you can branch from any message, get a different reply, and keep both.
The sibling replies stay navigable instead of being overwritten.

This matters because comparison is how you actually work — two tones, two
approaches, two models on the same question. Branching makes that a first-class
operation rather than something you fake with copy-paste.

Threads live in `~/.yachiyo/yachiyo.sqlite` and are full-text searchable, from
both the app and [`yachiyo thread search`](/docs/cli/thread/).

## Runs

A **run** is one execution of the agent loop: your message goes in, the model
thinks, calls tools, and produces a reply. A run has a status (`running`,
`completed`, `failed`, `cancelled`) and a token cost, both visible in the UI.

Runs are interruptible. While one is streaming you can **steer** it — send a
correction that lands mid-flight — or **queue a follow-up** for when it
finishes. Which one Enter does is configurable in **Settings → General →
Behavior**.

## Run modes

A **run mode** decides which tools the agent is allowed to touch for a turn. The
mode is picked in the composer and applies to that run.

| Mode        | What it can do                                                                              |
| ----------- | ------------------------------------------------------------------------------------------- |
| **Auto**    | Every enabled tool — editing, shell, browsing, delegation, automation. The default.         |
| **Explore** | `read`, `grep`, `glob`, `webRead`, `webSearch`. Reads and searches, never writes.           |
| **Plan**    | Explore's tools plus `write` and `bash`, for drafting a plan before touching anything real. |
| **Chat**    | No tools at all. Answers from the conversation and context it already has.                  |

Modes are a safety boundary, not a hint. In Explore mode the editing tools are
not merely discouraged — they are absent from the model's tool list.

Yachiyo runs **YOLO by default** inside whatever the mode allows: it uses tools
directly rather than asking permission per step. The mode is where you draw the
line, not a confirmation dialog.

## Workspaces

A **workspace** is the directory a thread operates in. Relative paths in tool
calls resolve from it, and file edits are scoped to it unless the agent uses an
absolute path.

You register workspaces in **Settings → Capabilities → Workspace** and attach one
per thread. Every file the agent changes during a run is **snapshotted**, so you
can review the diff afterwards instead of taking its word for it.

## Tools

Tools are what turn the model into an agent. The full set:

| Tool                                  | Purpose                                                                                             |
| ------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `read`, `write`, `edit`, `applyPatch` | Read and modify files. Reads come before writes — the agent must read a file before overwriting it. |
| `grep`, `glob`                        | Search file contents and paths.                                                                     |
| `bash`                                | Run shell commands, including long-running background tasks.                                        |
| `jsRepl`                              | Run incremental JavaScript cells in a persistent worker for the current agent execution.            |
| `pyRepl`                              | Run incremental Python cells in a persistent selected CPython environment.                          |
| `webSearch`, `webRead`                | Search the web and read pages as Markdown.                                                          |
| `useBrowser`                          | Drive a real browser session for things a fetch cannot do.                                          |
| `skillsRead`                          | Pull in a skill's full `SKILL.md` on demand.                                                        |
| `askUser`                             | Ask a clarifying question mid-run instead of guessing.                                              |
| `delegateTask`                        | Hand work to a subagent or an external coding agent.                                                |
| `remember`                            | Save a durable memory.                                                                              |
| `querySource`                         | Query local context sources — threads, memories, activity records — as read-only virtual tables.    |
| `useThings`, `reviewThings`           | Maintain **Things**: named context indexes you reference as `#name`.                                |
| `updateProfile`                       | Update `USER.md`, the structured profile document.                                                  |
| `updateTodoList`                      | Maintain the todo widget for multi-step work.                                                       |
| `useSentinel`                         | Set a conversation-level recurring check ("come back to this in 20 minutes").                       |
| `exitPlanMode`                        | Leave Plan mode once a plan is agreed.                                                              |

`pyRepl` selects its environment once on first use. A `.venv` at the workspace
root takes precedence and must be a working CPython 3.11 or newer virtual
environment; if that directory exists but is invalid, startup fails instead of
silently using another interpreter. When `.venv` is absent, Yachiyo falls back to
its private, managed CPython `3.12.14` environment. Bindings last for the current
parent execution or reusable worker lifetime; `reset: true` intentionally
discards them.

Cells support final-expression results, top-level `await`, timeouts, and bounded
`parallel()` work. They can return text, JSON, PNG/JPEG images, and math or data
renderings. Enabled Yachiyo tools are available through helpers such as `read`,
`write`, and `tool.<name>(args)`.

`%pip` always targets the selected interpreter. With a workspace `.venv`, package
changes belong to that project. With the managed fallback, packages persist
app-wide under `YACHIYO_HOME`; its first use downloads the runtime and a pinned,
wheel-only baseline of NumPy, SciPy, pandas, Matplotlib, Pillow, and scikit-image.

Selection never follows system or Homebrew Python and pip, an ambient
`VIRTUAL_ENV`, Conda, or virtual environments outside the workspace root
`.venv`. This is target isolation, not an OS sandbox: explicit Python file or
subprocess code, `tool.bash`, and third-party package or source-build hooks retain
their normal process authority.

There is no per-tool switch to flip. Which tools exist on a given run is decided
by the run mode alone — that is the control surface, and you pick it in the
composer per turn.

## Skills

A **skill** is a directory containing a `SKILL.md` file. The frontmatter gives it
a `name` and a `description`; the body is instructions.

The agent only sees names and descriptions up front. When one looks relevant it
calls `skillsRead` to load the full text. That keeps the context window free
until a skill is actually needed.

There is no runtime, no manifest, and no registration step. See
[Skills](/docs/guides/skills/).

## Models: chat model vs tool model

Two model slots, doing different jobs:

- **Chat model** — answers you. Set per thread, switchable per message.
- **Tool model** — does the background work: thread titles, memory distillation,
  context handoff when a thread gets long, image-to-text descriptions, group-chat
  probes, translation.

The tool model has three modes: `default` (reuse the chat model), `custom` (name
a specific cheap model), or `disabled` (skip auxiliary generation entirely).
Pointing it at something small and fast is usually the right call — this work is
frequent and unglamorous.

## Memory, soul, and profile

Three separate things that are easy to confuse:

- **Memory** — durable facts saved via the `remember` tool and recalled into
  later runs. Stored in the database, searchable, on by default.
- **`SOUL.md`** — the assistant's persona, including an evolving trait log that
  builds up over time. Editable in the app or via
  [`yachiyo soul`](/docs/cli/soul/).
- **`USER.md`** — who _you_ are, as a structured table: context, preferences,
  working style. The agent maintains it through the `updateProfile` tool.

All three feed the system context, and all three apply across every thread and
channel. See [Memory and persona](/docs/guides/memory-and-persona/).

## Things

A **Thing** is a named context index — a project, a decision, a long-running
piece of work — that you reference in conversation as `#name`. Conversations
attach themselves to Things as sources, so a future thread can pick up a topic
without you re-explaining it.

Things are not todos or reminders. They are stable topics that outlive any single
conversation.

## Channels

A **channel** connects an external platform — Telegram, QQ, Discord — to the same
local instance. Messages arrive as threads, with shared memory and persona.

Two roles matter:

- **Owner** — you. Full tool access, full memory, DMs treated as first-party.
- **Guest** — everyone else. Sandboxed workspace, filtered memory, per-user token
  limits, and an explicit allow/block status.

Group chats add a **group discussion mode**: a cheap probe model lurks on the
conversation and only wakes the full model when the bot should actually say
something. See [Channels](/docs/guides/channels/).

## Schedules

A **schedule** runs a prompt on its own — either recurring on a cron expression
or once at a specific time. Each fire creates a fresh thread, runs the prompt
with full tool access, records the result, and archives the thread.

Scheduled runs are how Yachiyo does something while you are not there. See
[Schedules](/docs/guides/schedules/).

## Essentials and prompts

Two small conveniences worth knowing:

- **Essentials** — preset thread launchers, each with its own icon, workspace,
  model, and privacy setting. One click starts the thread you start often.
- **Prompts** — saved text snippets bound to a keycode, expanded in the composer.

## Privacy mode

A thread marked private is excluded from search results and CLI listings unless
you explicitly pass `--include-private`. It is a visibility boundary within your
own machine, not encryption.
