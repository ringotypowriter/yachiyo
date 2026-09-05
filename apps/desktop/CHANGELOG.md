# @yachiyo/desktop

## 1.6.0

### Minor Changes

- [`39b1032`](https://github.com/ringotypowriter/yachiyo/commit/39b1032d1f9b78e2cffa93e59de8192e57885bec) Thanks [@ringotypowriter](https://github.com/ringotypowriter)! - ## Features

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

### Patch Changes

- Updated dependencies []:
  - @yachiyo/cli@1.6.0
  - @yachiyo/runtime@1.6.0
  - @yachiyo/shared@1.6.0
  - @yachiyo/core-skills@1.6.0

## 1.5.3

### Patch Changes

- [`21f3dec`](https://github.com/ringotypowriter/yachiyo/commit/21f3dec81e03d71fae163e5921019de7278b2f9c) Thanks [@ringotypowriter](https://github.com/ringotypowriter)! - Lots of update

- Updated dependencies []:
  - @yachiyo/cli@1.5.3
  - @yachiyo/runtime@1.5.3
  - @yachiyo/shared@1.5.3
  - @yachiyo/core-skills@1.5.3

## 1.5.2

### Patch Changes

- [`6d9e574`](https://github.com/ringotypowriter/yachiyo/commit/6d9e5744a0b52376da2262628dbfe35a325ce656) Thanks [@ringotypowriter](https://github.com/ringotypowriter)! - Added cross-device custom skill sync, encrypted provider backups, and CLI-managed app updates; improved QQBot attachments and group participation; introduced Codex Fast Mode, DeepSeek Max Effort, and model/runtime stats; and strengthened Windows support, web search, and long-conversation performance.

- Updated dependencies []:
  - @yachiyo/cli@1.5.2
  - @yachiyo/runtime@1.5.2
  - @yachiyo/shared@1.5.2
  - @yachiyo/core-skills@1.5.2

## 1.5.1

### Patch Changes

- [`e86c4d0`](https://github.com/ringotypowriter/yachiyo/commit/e86c4d0bf7c6a229d400cef083be82fb8c8fec37) Thanks [@ringotypowriter](https://github.com/ringotypowriter)! - Minor fix

- Updated dependencies []:
  - @yachiyo/cli@1.5.1
  - @yachiyo/runtime@1.5.1
  - @yachiyo/shared@1.5.1
  - @yachiyo/core-skills@1.5.1

## 1.5.0

### Minor Changes

- [`7b5c727`](https://github.com/ringotypowriter/yachiyo/commit/7b5c727e729fa3621b8a6123d2cc75fc8de0d518) Thanks [@ringotypowriter](https://github.com/ringotypowriter)! - Lots of update

### Patch Changes

- Updated dependencies []:
  - @yachiyo/cli@1.5.0
  - @yachiyo/runtime@1.5.0
  - @yachiyo/shared@1.5.0
  - @yachiyo/core-skills@1.5.0

## 1.4.1

### Patch Changes

- [`1472405`](https://github.com/ringotypowriter/yachiyo/commit/1472405238f608d6138fa5d36aeb64dca5d4f1aa) Thanks [@ringotypowriter](https://github.com/ringotypowriter)! - Locale

- Updated dependencies []:
  - @yachiyo/cli@1.4.1
  - @yachiyo/runtime@1.4.1
  - @yachiyo/shared@1.4.1
  - @yachiyo/core-skills@1.4.1

## 1.4.0

### Minor Changes

- [`14df282`](https://github.com/ringotypowriter/yachiyo/commit/14df2827c9be0e0a06ce50b729e926e9f0b50c53) Thanks [@ringotypowriter](https://github.com/ringotypowriter)! - Sparks!

### Patch Changes

- Updated dependencies []:
  - @yachiyo/cli@1.4.0
  - @yachiyo/runtime@1.4.0
  - @yachiyo/shared@1.4.0
  - @yachiyo/core-skills@1.4.0

## 1.3.0

### Minor Changes

- [`00f5880`](https://github.com/ringotypowriter/yachiyo/commit/00f58800e31cfc57a9de7b138fca16b0efc3ccc1) Thanks [@ringotypowriter](https://github.com/ringotypowriter)! - Lots of update

### Patch Changes

- Updated dependencies []:
  - @yachiyo/cli@1.3.0
  - @yachiyo/runtime@1.3.0
  - @yachiyo/shared@1.3.0
  - @yachiyo/core-skills@1.3.0

## 1.2.1

### Patch Changes

- [`17e2c3f`](https://github.com/ringotypowriter/yachiyo/commit/17e2c3f7d370bb2c1f968dfda6747635bffa01d6) Thanks [@ringotypowriter](https://github.com/ringotypowriter)! - Auto Wake & External Chat DM Improvement

- Updated dependencies []:
  - @yachiyo/cli@1.2.1
  - @yachiyo/runtime@1.2.1
  - @yachiyo/shared@1.2.1
  - @yachiyo/core-skills@1.2.1

## 1.2.0

### Minor Changes

- [`a96a78a`](https://github.com/ringotypowriter/yachiyo/commit/a96a78a751714c8235522a193a371b2562b68718) Thanks [@ringotypowriter](https://github.com/ringotypowriter)! - Things & Subagents

### Patch Changes

- Updated dependencies []:
  - @yachiyo/cli@1.2.0
  - @yachiyo/runtime@1.2.0
  - @yachiyo/shared@1.2.0
  - @yachiyo/core-skills@1.2.0
