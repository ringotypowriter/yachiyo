---
title: config.toml reference
description: Every section of ~/.yachiyo/config.toml, with types and defaults.
---

`~/.yachiyo/config.toml` holds everything except channel credentials, which live
in [`channels.toml`](/docs/reference/channels-toml/).

Edit it through the app, through
[`yachiyo config set`](/docs/cli/config/), or by hand. The file is rewritten in a
deterministic section order whenever the app saves, so hand edits survive but may
be reordered.

## `enabledTools`

```toml
enabledTools = ["read", "write", "edit", "bash", "grep", "glob", "webSearch"]
```

The tool whitelist a run starts from, written by the app. It is not a settings
switch — the [run mode](/docs/concepts/#run-modes) you pick in the composer is
what decides a turn's tool list. `skillsRead` and `reviewThings` are
runtime-managed and never appear here. See the [tool list](/docs/concepts/#tools).

## `runMode`

```toml
runMode = "auto"
```

Default run mode: `auto`, `explore`, `plan`, `chat`, or `custom`. Defaults to
`auto`. See [run modes](/docs/concepts/#run-modes).

## `[general]`

| Key                        | Type                                | Default                    | Description                                                                            |
| -------------------------- | ----------------------------------- | -------------------------- | -------------------------------------------------------------------------------------- |
| `sidebarVisibility`        | `"expanded"` \| `"collapsed"`       | `expanded`                 | Sidebar state                                                                          |
| `language`                 | `"auto"` \| `"en"` \| `"zh-CN"`     | `auto`                     | UI language; `auto` follows the system                                                 |
| `sidebarPreview`           | `boolean`                           | `true`                     | Message previews in the sidebar                                                        |
| `workSummary`              | `boolean`                           | `true`                     | Collapse tool activity into a work summary                                             |
| `themeId`                  | `string`                            | `mizu`                     | One of `mizu`, `sumi`, `ume`, `aoba`, `mint`, `fuji`, `yamabuki`, `gobyou`, `murasaki` |
| `themeAppearance`          | `"system"` \| `"light"` \| `"dark"` | `system`                   | Light/dark mode                                                                        |
| `uiFontSize`               | `number`                            | —                          | UI font size                                                                           |
| `chatFontSize`             | `number`                            | —                          | Chat font size                                                                         |
| `chatPanelOpacity`         | `number`                            | —                          | Chat panel opacity                                                                     |
| `updateChannel`            | `"stable"` \| `"beta"`              | —                          | Which release channel to update from                                                   |
| `demoMode`                 | `boolean`                           | `false`                    | Demo/screenshot mode                                                                   |
| `preventSystemSleep`       | `boolean`                           | `false`                    | Keep the machine awake during runs                                                     |
| `notifyRunCompleted`       | `boolean`                           | `true`                     | Notify when a run finishes                                                             |
| `notifyCodingTaskStarted`  | `boolean`                           | `true`                     | Notify when a delegated task starts                                                    |
| `notifyCodingTaskFinished` | `boolean`                           | `true`                     | Notify when a delegated task finishes                                                  |
| `translatorShortcut`       | `string`                            | `CommandOrControl+Shift+T` | Global translator hotkey                                                               |
| `jotdownShortcut`          | `string`                            | `CommandOrControl+Shift+J` | Global jot-down hotkey                                                                 |

### `[general.activityTracking]`

| Key                   | Type                              | Default  | Description                                                     |
| --------------------- | --------------------------------- | -------- | --------------------------------------------------------------- |
| `mode`                | `"off"` \| `"simple"` \| `"full"` | `simple` | How much foreground-app activity to record                      |
| `accessibilityDenied` | `boolean`                         | —        | Set when you have explicitly denied accessibility for full mode |
| `ocr.enabled`         | `boolean`                         | `false`  | Capture window text via OCR                                     |
| `ocr.excludedApps`    | `string[]`                        | `[]`     | Apps never OCR'd                                                |

## `[chat]`

| Key                           | Type                                           | Default        | Description                                             |
| ----------------------------- | ---------------------------------------------- | -------------- | ------------------------------------------------------- |
| `activeRunEnterBehavior`      | `"enter-steers"` \| `"enter-queues-follow-up"` | `enter-steers` | What Enter does while a run is streaming                |
| `stripCompact`                | `boolean`                                      | `true`         | Compact long thread history                             |
| `stripCompactThresholdTokens` | `number`                                       | —              | Token count that triggers compaction                    |
| `autoMemoryDistillation`      | `boolean`                                      | `true`         | Distill memory after runs                               |
| `inputBufferEnabled`          | `boolean`                                      | `false`        | Buffer typing before sending                            |
| `recapEnabled`                | `boolean`                                      | `true`         | Recap context on resume                                 |
| `imageToTextModel`            | `object`                                       | —              | `{ providerName, model }`; falls back to the tool model |

## `[workspace]`

| Key           | Type       | Description                                                         |
| ------------- | ---------- | ------------------------------------------------------------------- |
| `savedPaths`  | `string[]` | Registered workspace directories                                    |
| `pathLabels`  | `table`    | Path → label. Labels for paths no longer saved are pruned on write. |
| `editorApp`   | `string`   | App used to open files                                              |
| `terminalApp` | `string`   | App used to open a terminal                                         |
| `markdownApp` | `string`   | App used to open Markdown                                           |

## `[sync]`

| Key       | Type     | Description                                           |
| --------- | -------- | ----------------------------------------------------- |
| `syncDir` | `string` | Sync folder path. Empty disables sync on this device. |

## `[skills]`

| Key        | Type       | Description                     |
| ---------- | ---------- | ------------------------------- |
| `enabled`  | `string[]` | Active skill names              |
| `disabled` | `string[]` | Explicitly disabled skill names |

## `[toolModel]`

| Key            | Type                                      | Default   | Description                                                            |
| -------------- | ----------------------------------------- | --------- | ---------------------------------------------------------------------- |
| `mode`         | `"default"` \| `"custom"` \| `"disabled"` | `default` | `default` reuses the chat model; `disabled` skips auxiliary generation |
| `providerId`   | `string`                                  | `""`      | Provider UUID when `mode = "custom"`                                   |
| `providerName` | `string`                                  | `""`      | Provider display name                                                  |
| `model`        | `string`                                  | `""`      | Model name                                                             |

## `[defaultModel]`

| Key            | Type     | Description            |
| -------------- | -------- | ---------------------- |
| `providerName` | `string` | Provider for new chats |
| `model`        | `string` | Model for new chats    |

Prefer [`yachiyo provider set-default`](/docs/cli/provider/) over editing this
directly.

## `[memory]`

| Key          | Type      | Default | Description                    |
| ------------ | --------- | ------- | ------------------------------ |
| `enabled`    | `boolean` | `true`  | Master switch for memory       |
| `autoRecall` | `boolean` | `true`  | Pull recalled memory into runs |

## `[webSearch]`

Yachiyo selects and falls back between Bing, Google, Brave, DuckDuckGo, and Exa
automatically. This section stores browser-session metadata and optional Exa access;
it does not choose a provider.

| Key                                | Type     | Default | Description                           |
| ---------------------------------- | -------- | ------- | ------------------------------------- |
| `browserSession.sourceBrowser`     | `string` | —       | Browser the session was imported from |
| `browserSession.sourceProfileName` | `string` | `""`    | Profile it came from                  |
| `browserSession.importedAt`        | `string` | `""`    | Import timestamp                      |
| `browserSession.lastImportError`   | `string` | `""`    | Last import error, if any             |
| `exa.apiKey`                       | `string` | `""`    | Exa API key                           |
| `exa.baseUrl`                      | `string` | `""`    | Custom Exa endpoint                   |

## `[[providers]]`

An array of tables, one per provider.

| Key                                               | Type       | Description                                                                                        |
| ------------------------------------------------- | ---------- | -------------------------------------------------------------------------------------------------- |
| `id`                                              | `string`   | Stable UUID                                                                                        |
| `presetKey`                                       | `string`   | Links to a built-in preset (e.g. `openai`, `google-vertex`)                                        |
| `name`                                            | `string`   | Display name                                                                                       |
| `type`                                            | `string`   | `openai`, `openai-responses`, `openai-codex`, `anthropic`, `gemini`, `vertex`, or `vercel-gateway` |
| `apiKey`                                          | `string`   | API key. Redacted in all CLI output.                                                               |
| `baseUrl`                                         | `string`   | API base URL                                                                                       |
| `thinkingEnabled`                                 | `boolean`  | Whether reasoning is on by default                                                                 |
| `reasoning`                                       | `table`    | Effort defaults and per-model reasoning config                                                     |
| `codexSessionPath`                                | `string`   | Path to Codex `auth.json`, for `openai-codex`                                                      |
| `project`, `location`                             | `string`   | Vertex only                                                                                        |
| `serviceAccountEmail`, `serviceAccountPrivateKey` | `string`   | Vertex only                                                                                        |
| `modelList.enabled`                               | `string[]` | Models shown in the picker                                                                         |
| `modelList.disabled`                              | `string[]` | Known but hidden models                                                                            |
| `modelList.imageIncapable`                        | `string[]` | Models that cannot accept images                                                                   |

## `[[prompts]]`

| Key       | Type     | Description                            |
| --------- | -------- | -------------------------------------- |
| `keycode` | `string` | Trigger code; must start with a letter |
| `text`    | `string` | Text it expands to                     |

## `[[subagentProfiles]]`

External ACP agent profiles. Deprecated — see
[subagents](/docs/guides/coding-agents/).

| Key           | Type       | Description                    |
| ------------- | ---------- | ------------------------------ |
| `id`          | `string`   | Stable identifier              |
| `name`        | `string`   | Display name                   |
| `enabled`     | `boolean`  | Whether the profile is offered |
| `description` | `string`   | Shown in the UI                |
| `command`     | `string`   | Executable                     |
| `args`        | `string[]` | Arguments                      |
| `env`         | `table`    | Extra environment variables    |

## `[subagents]`

| Key                  | Type                  | Default  | Description                                   |
| -------------------- | --------------------- | -------- | --------------------------------------------- |
| `mode`               | `"worker"` \| `"acp"` | `worker` | Subagent runtime backend                      |
| `enabledNamedAgents` | `string[]`            | all four | Any of `explore`, `plan`, `review`, `general` |
| `preferredModels`    | `table`               | —        | Per-agent `{ providerName, model }` overrides |

## `[[essentials]]`

Preset thread launchers.

| Key             | Type                   | Description                      |
| --------------- | ---------------------- | -------------------------------- |
| `id`            | `string`               | Stable identifier                |
| `icon`          | `string`               | Emoji or image reference         |
| `iconType`      | `"emoji"` \| `"image"` | How to interpret `icon`          |
| `label`         | `string`               | Display label                    |
| `workspacePath` | `string`               | Workspace the thread starts in   |
| `privacyMode`   | `boolean`              | Start the thread in privacy mode |
| `modelOverride` | `table`                | `{ providerName, model }`        |
| `order`         | `number`               | Sort position                    |

:::caution
This file contains provider API keys in plain text. Do not commit it, and do not
put it in a shared folder. Note that enabling [sync](/docs/guides/sync/) copies
this file into your sync directory.
:::
