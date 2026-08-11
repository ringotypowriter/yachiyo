---
title: channels.toml reference
description: Every key in ~/.yachiyo/channels.toml — platform credentials, group discussion tuning, and guest privacy.
---

`~/.yachiyo/channels.toml` holds channel credentials and tuning, kept separate
from [`config.toml`](/docs/reference/config-toml/) so bot tokens never mix with
the rest of your settings.

Keys here are `snake_case`, unlike `config.toml`.

:::caution
This file stores bot tokens and client secrets in plain text, and unlike provider
API keys they are **not** redacted from CLI output. Treat it as a credential
store.
:::

## `[telegram]`

| Key                            | Type      | Description                                  |
| ------------------------------ | --------- | -------------------------------------------- |
| `enabled`                      | `boolean` | Whether the Telegram bot runs                |
| `bot_token`                    | `string`  | Token from @BotFather                        |
| `model_provider`, `model_name` | `string`  | Optional model override for Telegram threads |
| `[telegram.group]`             | table     | Group discussion settings — see below        |

## `[qq]`

NapCatQQ over OneBot v11.

| Key                            | Type      | Description                                            |
| ------------------------------ | --------- | ------------------------------------------------------ |
| `enabled`                      | `boolean` | Whether the QQ bot runs                                |
| `ws_url`                       | `string`  | NapCatQQ forward WebSocket, e.g. `ws://localhost:3001` |
| `token`                        | `string`  | Optional auth token for the WS connection              |
| `model_provider`, `model_name` | `string`  | Optional model override                                |
| `[qq.group]`                   | table     | Group discussion settings                              |

## `[discord]`

| Key                            | Type      | Description                                        |
| ------------------------------ | --------- | -------------------------------------------------- |
| `enabled`                      | `boolean` | Whether the Discord bot runs                       |
| `bot_token`                    | `string`  | Token from the Discord Developer Portal            |
| `model_provider`, `model_name` | `string`  | Optional model override                            |
| `[discord.group]`              | table     | Group discussion settings for server text channels |

## `[qqbot]`

QQ Official Bot API. **Direct messages only** — no group support.

| Key                            | Type      | Description                         |
| ------------------------------ | --------- | ----------------------------------- |
| `enabled`                      | `boolean` | Whether the QQ Official Bot runs    |
| `app_id`                       | `string`  | App ID from the QQ Developer Portal |
| `client_secret`                | `string`  | Client secret                       |
| `model_provider`, `model_name` | `string`  | Optional model override             |

## `[<platform>.group]`

Per-platform group discussion settings. Available for `telegram`, `qq`, and
`discord`.

| Key                                                              | Type      | Default    | Description                                    |
| ---------------------------------------------------------------- | --------- | ---------- | ---------------------------------------------- |
| `enabled`                                                        | `boolean` | —          | Whether group discussion runs on this platform |
| `model_provider`, `model_name`                                   | `string`  | tool model | Model for the group probe                      |
| `vision`                                                         | `boolean` | `false`    | Pass group images to the probe model           |
| `active_check_interval_ms`                                       | `number`  | `60000`    | Probe interval in the active phase             |
| `engaged_check_interval_ms`                                      | `number`  | `30000`    | Probe interval in the engaged phase            |
| `wake_buffer_ms`                                                 | `number`  | `60000`    | Delay before waking on new activity            |
| `dormancy_miss_count`                                            | `number`  | `3`        | Quiet checks before dropping to dormant        |
| `disengage_miss_count`                                           | `number`  | `3`        | Quiet checks before leaving engaged            |
| `probe_adapter`, `probe_adapter_provider`, `probe_adapter_model` | `string`  | —          | Headless probe adapter override                |

## `[privacy]`

| Key                      | Type       | Description                                                            |
| ------------------------ | ---------- | ---------------------------------------------------------------------- |
| `guest_instruction`      | `string`   | Custom context injected into the system prompt for guest conversations |
| `memory_filter_keywords` | `string[]` | Memory results containing these keywords are hidden from guests        |

## `[image_to_text]`

| Key       | Type      | Default | Description                                       |
| --------- | --------- | ------- | ------------------------------------------------- |
| `enabled` | `boolean` | `false` | Pre-describe images in group messages as alt text |

## Global group settings

Top-level keys applying across platforms, with per-platform values winning where
both are set.

| Key                                            | Type     | Default                      | Description                                                                                                   |
| ---------------------------------------------- | -------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `check_interval_ms`                            | `number` | —                            | Global override for the active-phase probe interval                                                           |
| `dm_compact_token_threshold_k`                 | `number` | `64`                         | DM context budget, in thousands of tokens                                                                     |
| `group_context_window_k`                       | `number` | `64`                         | Group probe sliding window, in thousands of tokens                                                            |
| `group_handoff_threshold_k`                    | `number` | `2 × group_context_window_k` | Probe thread size above which older transcript is summarized into a rolling handoff                           |
| `rewrite_model_provider`, `rewrite_model_name` | `string` | —                            | Model that rewrites outgoing group replies into the persona's voice. Unset means replies go out as generated. |

The handoff threshold's floor is twice the context window — that gap is
hysteresis, so a long-running group does not re-summarize on every turn.

## See also

- [Channels](/docs/guides/channels/) — setup and the guest model
- [`yachiyo channel`](/docs/cli/channel/) — inspect users and groups
