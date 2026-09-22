---
'@yachiyo/desktop': minor
---

## Features

- **Minimal prompt:** A new Context setting that trims the preset rules and lets the model rely more on its own judgment, while keeping personality, user preferences, and memory.
- **PDF viewer:** Open PDF files inside the app with page navigation and zoom, loaded lazily so the chat surface stays light.
- **Share responses:** Export a response as a paginated, themed document with tool views included.
- **Conversation avatar:** The avatar now reflects what Yachiyo is doing with thinking, working, waiting, and idle states, plus a run indicator that follows the current step.
- **Task rows:** Delegated agents and background tasks appear as dedicated timeline rows, with a tasks chip that summarizes what is still running and retry notices when a step is retried.
- **Group discussion modes:** Channels can run group discussion in `probe` mode (follow group activity) or `mention` mode (reply only when the bot is mentioned), with a separate reasoning effort for group replies.
- **DM effort:** Set reasoning effort for direct-message replies on Telegram, QQ, Discord, and QQBot, independently of the group setting.
- **Responses WebSocket:** OpenAI Responses requests can travel over a per-thread WebSocket so multi-step runs keep their server-side prompt cache. Unsupported endpoints stay on HTTP and can be retried from Settings; temporary failures fall back to HTTP automatically.

## Improvements

- Migrated to AI SDK v7 with runtime-owned tool lifecycle events.
- Browser automation now scopes operations to a session with deadlines and cancellation, saves large outputs to files, and truncates previews.
- Consecutive tool calls fold into a cumulative history so long runs stay readable.
- Group chat prompts and message formatting carry clearer context.

## Fixes

- Final group replies are delivered through the runtime.
- Foreground activity is preserved while input is idle.
- The `read` tool now rejects GIF files with guidance to convert them first.
- Avoided unnecessary avatar updates and hidden animations.
