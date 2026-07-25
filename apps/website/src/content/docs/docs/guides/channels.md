---
title: Channels
description: Serve Telegram, QQ, and Discord from one local instance, with access control, guest sandboxing, and group discussion mode.
---

A channel connects an external platform to the same local Yachiyo instance.
Messages arrive as threads with the same persona and the same memory — this is
the same assistant, not a separate bot that happens to share a name.

Credentials live in `~/.yachiyo/channels.toml`, deliberately separate from
`config.toml` so bot tokens never mix with the rest of your settings.

Set everything up in **Settings → Channels**.

## Supported platforms

| Platform            | Transport                | Needs                                               |
| ------------------- | ------------------------ | --------------------------------------------------- |
| **Telegram**        | Bot API                  | Bot token from [@BotFather](https://t.me/BotFather) |
| **QQ**              | NapCatQQ over OneBot v11 | WebSocket URL, optional token                       |
| **QQ Official Bot** | QQ Bot API (DM only)     | App ID + client secret from the QQ Developer Portal |
| **Discord**         | Bot gateway              | Bot token from the Discord Developer Portal         |

Each platform can carry its own model override, so a chatty Telegram bot can run
on something cheaper than your desktop default.

### Telegram

Create a bot with @BotFather, paste the token into **Settings → Channels →
Telegram**, and enable it. Restart the service from the same pane if you change
the token.

### QQ (NapCatQQ)

Yachiyo does not talk to QQ directly — it connects to a running
[NapCatQQ](https://github.com/NapNeko/NapCatQQ) instance over OneBot v11. Point
`wsUrl` at NapCat's forward WebSocket (typically `ws://localhost:3001`) and set
the token if you configured one.

### QQ Official Bot

The official Bot API path, using an App ID and client secret from the QQ
Developer Portal. **Direct messages only** — no group support on this transport.
Use the NapCatQQ path if you need groups.

### Discord

A standard bot token from the Developer Portal. Discord supports both DMs and
server text channels; server channels go through group discussion mode.

## Access control

Nobody gets to use your assistant by messaging your bot. Users and groups are
registered on first contact and start in a pending state.

**Users** — `pending` → `allowed` or `blocked`, with a role of `owner` or
`guest`. Each carries a token quota (`usageLimitKTokens`, null for unlimited) and
accumulated usage.

**Groups** — `pending` → `approved` or `blocked`. Approving a group starts its
monitor immediately if the app is running.

Note the two vocabularies differ: users are _allowed_, groups are _approved_.

Approve from **Settings → Channels**, or just ask — it can list who is waiting
and act on your answer:

> Who's pending on my channels right now?

For scripts and the exact commands, the CLI:

```bash
yachiyo channel users --json
yachiyo channel groups --json
yachiyo channel groups set-status <group-id> approval
yachiyo channel groups set-status <group-id> block
```

See the [`channel` CLI reference](/docs/cli/channel/).

:::caution[Approval is a real decision]
Everything in the guest model below is what stands between a stranger on
Telegram and your assistant. Approve people, not requests — and be aware that
asking Yachiyo to "approve everyone pending" hands it a decision you should be
making yourself.
:::

## The guest model

A guest is not you, and Yachiyo treats them accordingly:

- **Sandboxed workspace.** Each guest and group gets its own workspace directory.
- **Filtered memory.** Memory results containing any of your
  `memoryFilterKeywords` are hidden from guests.
- **Separate profile.** Guests get their own `USER.md` mode, so what the
  assistant learns about a visitor never lands in your profile.
- **Token limits.** Per-user quotas, enforced.
- **Guest instruction.** A custom block injected into the system prompt for guest
  conversations — what guests should know about you, and any rules for how the
  assistant should handle them.

## Group discussion mode

Having a bot reply to every message in a group chat is intolerable. So group
mode runs a **probe**: a cheap model watches the conversation and decides whether
the bot has anything worth saying. Only then does the full model get involved.

The monitor is a three-phase state machine:

| Phase       | Behavior                                                                      |
| ----------- | ----------------------------------------------------------------------------- |
| **Dormant** | Buffering messages, not checking. Wakes on activity.                          |
| **Active**  | Checking periodically (default every 60s) to see if it should speak.          |
| **Engaged** | Recently spoke; checks more often (default every 30s) to hold a conversation. |

It falls back down the ladder after a few checks with nothing worth saying —
three misses by default at each step. Messages that arrive while dormant sit in a
buffer with a wake delay (default 60s) so a burst of chatter produces one
considered response rather than three reflexive ones.

### Group tuning

| Setting              | Default                  | What it does                                                                      |
| -------------------- | ------------------------ | --------------------------------------------------------------------------------- |
| Group model          | tool model               | Model that runs the probe                                                         |
| Check interval       | 60s active / 30s engaged | How often the probe evaluates                                                     |
| Verbosity            | 0                        | `0` = the normal throttle curve, `1` = never throttled                            |
| Group context window | 64k tokens               | Sliding window budget for probe messages                                          |
| Rewrite model        | unset                    | Rewrites outgoing replies into the persona's voice; unset sends them as generated |
| Vision               | off                      | Pass images from group messages to the probe                                      |
| Image to text        | off                      | Pre-describe images as alt text before the probe sees them                        |

The group probe thread also does a rolling handoff: once the raw transcript
outgrows roughly twice the context window, older material is summarized rather
than dropped, with hysteresis so it does not re-summarize every turn.

DM threads have their own compaction threshold (default 64k tokens), set
separately in the same pane.

## Sending messages yourself

`yachiyo send channel` pushes a message straight to a platform as the bot — no
thread, no inference:

```bash
yachiyo channel users --json                       # find the target id
yachiyo send channel <id> "The build finished."
```

Useful in scripts and CI. The app must be running and the relevant channel
service must be active. See the [`send` CLI reference](/docs/cli/send/).

:::caution[channels.toml holds secrets]
Bot tokens and client secrets are stored in plain text in
`~/.yachiyo/channels.toml`. Unlike provider API keys, these are **not** redacted
in output — treat the file as a credential store, and keep it out of any synced
or shared folder.
:::
