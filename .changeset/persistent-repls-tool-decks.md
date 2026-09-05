---
'@yachiyo/desktop': minor
---

## Features

- **Python execution:** Yachiyo can now work in a persistent Python interpreter, reuse variables across calls, display plots and images, and call other enabled tools from Python. A managed Python environment handles setup, with install, repair, rebuild, and removal controls in Settings.
- **Persistent JavaScript:** JavaScript execution now preserves state by default, supports static imports and top-level await, and resolves file operations against each call's working directory. Cells also show a short title in the conversation.
- **Tool decks:** Browse consecutive tool calls in a chronological deck with selectable details, improved hover behavior, and automatic layout updates as output changes. Compact work summaries remain available in Settings.
- **Task controls:** Yachiyo can inspect delegated tasks with `getTask` and send follow-ups with `steerTask`, including resuming idle workers with their existing context. These replace the former `sendMessage` tool.
- **OrcaRouter:** Added a provider preset with session-aware requests.

## Improvements

- Faster desktop cold starts through deferred loading of heavier UI features and reduced startup database work.
- Long conversations open at the latest messages and load older messages as you scroll upward.
- More informative run statistics, including generation speed and first-token timing that accounts for reasoning and tool input. Generation speed excludes each model step's first-token wait and tool execution time.
- Conversations with active delegated tasks remain visible in the sidebar's running filter.
- Clearer background-task errors and logs, more reliable process cleanup, and improved packaged runtime support on macOS and Windows.

## Fixes

- Fixed update-installation races and recovery of update confirmations after restart. Beta users can now receive newer stable releases.
- Improved interrupted-worker retries, follow-up handling, and scrolling within the agents panel.
- Agent rows now show a single type label next to each worker's name.
- Keep the visible message in place when older history loads and row heights settle, without overriding navigation to a newly sent message.
- Fixed local Markdown links with percent-encoded filenames while preserving literal-filename fallbacks.
- Reject unsafe conversation IDs when deriving temporary workspace paths, preventing paths from escaping the workspace root.
- Fixed repeated settings-sync conflict prompts for previously resolved values and stabilized provider identities in legacy configurations.
- Browser automation now waits for page-initiated navigation to settle before reading the next page state.
- Improved QQBot request timeout handling.
- File reads now explicitly mark the end of a complete text file so the agent can distinguish completion from paginated output.

## Upgrade note

Tool Deck is now the default tool-call display. Existing Summary settings are switched to Tool Deck once during this upgrade, including previously selected Summary settings because older versions did not record whether the value was chosen manually. After upgrading, you can switch back to Summary in Settings; subsequent launches and settings saves preserve that choice.
