---
title: config.toml 参考
description: ~/.yachiyo/config.toml 的每个小节，附类型与默认值。
---

`~/.yachiyo/config.toml` 装着除频道凭据之外的一切，后者在 [`channels.toml`](/zh/docs/reference/channels-toml/) 里。

可以在应用里改，用 [`yachiyo config set`](/zh/docs/cli/config/) 改，或者手动改。应用每次保存都会按确定的小节顺序重写这个文件，所以手动编辑会保留，但可能被重新排序。

## `enabledTools`

```toml
enabledTools = ["read", "write", "edit", "bash", "grep", "glob", "webSearch"]
```

一次运行起始的工具白名单，由应用写入。它不是一个设置开关 —— 决定某一轮工具列表的是你在输入框里选的[运行模式](/zh/docs/concepts/#运行模式)。`skillsRead` 和 `reviewThings` 由运行时管理，不会出现在这里。见[工具列表](/zh/docs/concepts/#工具)。

## `runMode`

```toml
runMode = "auto"
```

默认运行模式：`auto`、`explore`、`plan`、`chat` 或 `custom`。默认为 `auto`。见[运行模式](/zh/docs/concepts/#运行模式)。

## `[general]`

| 键                         | 类型                                | 默认                       | 说明                                                                                 |
| -------------------------- | ----------------------------------- | -------------------------- | ------------------------------------------------------------------------------------ |
| `sidebarVisibility`        | `"expanded"` \| `"collapsed"`       | `expanded`                 | 侧边栏状态                                                                           |
| `language`                 | `"auto"` \| `"en"` \| `"zh-CN"`     | `auto`                     | 界面语言；`auto` 跟随系统                                                            |
| `sidebarPreview`           | `boolean`                           | `true`                     | 侧边栏中的消息预览                                                                   |
| `workSummary`              | `boolean`                           | `true`                     | 把工具活动折叠成工作摘要                                                             |
| `themeId`                  | `string`                            | `mizu`                     | `mizu`、`sumi`、`ume`、`aoba`、`mint`、`fuji`、`yamabuki`、`gobyou`、`murasaki` 之一 |
| `themeAppearance`          | `"system"` \| `"light"` \| `"dark"` | `system`                   | 明暗模式                                                                             |
| `uiFontSize`               | `number`                            | ——                         | 界面字号                                                                             |
| `chatFontSize`             | `number`                            | ——                         | 聊天字号                                                                             |
| `chatPanelOpacity`         | `number`                            | ——                         | 聊天面板不透明度                                                                     |
| `updateChannel`            | `"stable"` \| `"beta"`              | ——                         | 从哪个发布通道更新                                                                   |
| `demoMode`                 | `boolean`                           | `false`                    | 演示/截图模式                                                                        |
| `preventSystemSleep`       | `boolean`                           | `false`                    | 运行期间不让机器休眠                                                                 |
| `notifyRunCompleted`       | `boolean`                           | `true`                     | 运行结束时通知                                                                       |
| `notifyCodingTaskStarted`  | `boolean`                           | `true`                     | 委派任务开始时通知                                                                   |
| `notifyCodingTaskFinished` | `boolean`                           | `true`                     | 委派任务结束时通知                                                                   |
| `translatorShortcut`       | `string`                            | `CommandOrControl+Shift+T` | 全局翻译器热键                                                                       |
| `jotdownShortcut`          | `string`                            | `CommandOrControl+Shift+J` | 全局速记热键                                                                         |

### `[general.activityTracking]`

| 键                    | 类型                              | 默认     | 说明                                       |
| --------------------- | --------------------------------- | -------- | ------------------------------------------ |
| `mode`                | `"off"` \| `"simple"` \| `"full"` | `simple` | 记录多少前台应用活动                       |
| `accessibilityDenied` | `boolean`                         | ——       | 你明确拒绝了 full 模式的辅助功能权限时置位 |
| `ocr.enabled`         | `boolean`                         | `false`  | 通过 OCR 捕获窗口文本                      |
| `ocr.excludedApps`    | `string[]`                        | `[]`     | 永不 OCR 的应用                            |

## `[chat]`

| 键                            | 类型                                           | 默认           | 说明                                      |
| ----------------------------- | ---------------------------------------------- | -------------- | ----------------------------------------- |
| `activeRunEnterBehavior`      | `"enter-steers"` \| `"enter-queues-follow-up"` | `enter-steers` | 运行流式输出时回车做什么                  |
| `stripCompact`                | `boolean`                                      | `true`         | 压缩过长的线程历史                        |
| `stripCompactThresholdTokens` | `number`                                       | ——             | 触发压缩的 token 数                       |
| `autoMemoryDistillation`      | `boolean`                                      | `true`         | 运行后蒸馏记忆                            |
| `inputBufferEnabled`          | `boolean`                                      | `false`        | 发送前缓冲输入                            |
| `recapEnabled`                | `boolean`                                      | `true`         | 恢复时回顾上下文                          |
| `imageToTextModel`            | `object`                                       | ——             | `{ providerName, model }`；回落到工具模型 |

## `[workspace]`

| 键            | 类型       | 说明                                                    |
| ------------- | ---------- | ------------------------------------------------------- |
| `savedPaths`  | `string[]` | 已注册的工作区目录                                      |
| `pathLabels`  | `table`    | 路径 → 标签。已不再保存的路径对应的标签会在写入时清理。 |
| `editorApp`   | `string`   | 打开文件用的应用                                        |
| `terminalApp` | `string`   | 打开终端用的应用                                        |
| `markdownApp` | `string`   | 打开 Markdown 用的应用                                  |

## `[sync]`

| 键        | 类型     | 说明                                     |
| --------- | -------- | ---------------------------------------- |
| `syncDir` | `string` | 同步文件夹路径。留空则在本设备停用同步。 |

## `[skills]`

| 键         | 类型       | 说明             |
| ---------- | ---------- | ---------------- |
| `enabled`  | `string[]` | 启用的技能名     |
| `disabled` | `string[]` | 显式停用的技能名 |

## `[toolModel]`

| 键             | 类型                                      | 默认      | 说明                                            |
| -------------- | ----------------------------------------- | --------- | ----------------------------------------------- |
| `mode`         | `"default"` \| `"custom"` \| `"disabled"` | `default` | `default` 复用聊天模型；`disabled` 跳过辅助生成 |
| `providerId`   | `string`                                  | `""`      | `mode = "custom"` 时的供应商 UUID               |
| `providerName` | `string`                                  | `""`      | 供应商显示名称                                  |
| `model`        | `string`                                  | `""`      | 模型名                                          |

## `[defaultModel]`

| 键             | 类型     | 说明               |
| -------------- | -------- | ------------------ |
| `providerName` | `string` | 新对话使用的供应商 |
| `model`        | `string` | 新对话使用的模型   |

优先用 [`yachiyo provider set-default`](/zh/docs/cli/provider/) 而不是直接改这里。

## `[memory]`

| 键           | 类型      | 默认   | 说明                   |
| ------------ | --------- | ------ | ---------------------- |
| `enabled`    | `boolean` | `true` | 记忆总开关             |
| `autoRecall` | `boolean` | `true` | 把调取到的记忆带进运行 |

## `[webSearch]`

八千代会自动在 Bing、Google、Brave、DuckDuckGo 与 Exa 之间选择并故障转移。这里仅保存浏览器会话信息和可选的 Exa 接入，不再指定搜索供应商。

| 键                                 | 类型     | 默认 | 说明                     |
| ---------------------------------- | -------- | ---- | ------------------------ |
| `browserSession.sourceBrowser`     | `string` | ——   | 会话是从哪个浏览器导入的 |
| `browserSession.sourceProfileName` | `string` | `""` | 来源配置文件             |
| `browserSession.importedAt`        | `string` | `""` | 导入时间戳               |
| `browserSession.lastImportError`   | `string` | `""` | 上次导入的错误（如果有） |
| `exa.apiKey`                       | `string` | `""` | Exa API key              |
| `exa.baseUrl`                      | `string` | `""` | 自定义 Exa 端点          |

## `[[providers]]`

一个表数组，每个供应商一项。

| 键                                                | 类型       | 说明                                                                                              |
| ------------------------------------------------- | ---------- | ------------------------------------------------------------------------------------------------- |
| `id`                                              | `string`   | 稳定 UUID                                                                                         |
| `presetKey`                                       | `string`   | 关联到某个内置预设（如 `openai`、`google-vertex`）                                                |
| `name`                                            | `string`   | 显示名称                                                                                          |
| `type`                                            | `string`   | `openai`、`openai-responses`、`openai-codex`、`anthropic`、`gemini`、`vertex` 或 `vercel-gateway` |
| `apiKey`                                          | `string`   | API key。在所有命令行输出中打码。                                                                 |
| `baseUrl`                                         | `string`   | API base URL                                                                                      |
| `thinkingEnabled`                                 | `boolean`  | 推理是否默认开启                                                                                  |
| `reasoning`                                       | `table`    | 强度默认值与按模型的推理配置                                                                      |
| `codexSessionPath`                                | `string`   | Codex `auth.json` 的路径，用于 `openai-codex`                                                     |
| `project`、`location`                             | `string`   | 仅 Vertex                                                                                         |
| `serviceAccountEmail`、`serviceAccountPrivateKey` | `string`   | 仅 Vertex                                                                                         |
| `modelList.enabled`                               | `string[]` | 在选择器里显示的模型                                                                              |
| `modelList.disabled`                              | `string[]` | 已知但隐藏的模型                                                                                  |
| `modelList.imageIncapable`                        | `string[]` | 不能接收图片的模型                                                                                |

## `[[prompts]]`

| 键        | 类型     | 说明                   |
| --------- | -------- | ---------------------- |
| `keycode` | `string` | 触发码；必须以字母开头 |
| `text`    | `string` | 展开成的文本           |

## `[[subagentProfiles]]`

外部 ACP 智能体档案。已废弃 —— 见[子智能体](/zh/docs/guides/coding-agents/)。

| 键            | 类型       | 说明             |
| ------------- | ---------- | ---------------- |
| `id`          | `string`   | 稳定标识符       |
| `name`        | `string`   | 显示名称         |
| `enabled`     | `boolean`  | 该档案是否被提供 |
| `description` | `string`   | 界面上显示       |
| `command`     | `string`   | 可执行文件       |
| `args`        | `string[]` | 参数             |
| `env`         | `table`    | 额外的环境变量   |

## `[subagents]`

| 键                   | 类型                  | 默认     | 说明                                              |
| -------------------- | --------------------- | -------- | ------------------------------------------------- |
| `mode`               | `"worker"` \| `"acp"` | `worker` | 子智能体运行后端                                  |
| `enabledNamedAgents` | `string[]`            | 全部四个 | `explore`、`plan`、`review`、`general` 的任意组合 |
| `preferredModels`    | `table`               | ——       | 按智能体的 `{ providerName, model }` 覆盖         |

## `[[essentials]]`

预设的线程启动器。

| 键              | 类型                   | 说明                      |
| --------------- | ---------------------- | ------------------------- |
| `id`            | `string`               | 稳定标识符                |
| `icon`          | `string`               | Emoji 或图片引用          |
| `iconType`      | `"emoji"` \| `"image"` | 如何解释 `icon`           |
| `label`         | `string`               | 显示标签                  |
| `workspacePath` | `string`               | 线程启动时所在的工作区    |
| `privacyMode`   | `boolean`              | 以隐私模式启动线程        |
| `modelOverride` | `table`                | `{ providerName, model }` |
| `order`         | `number`               | 排序位置                  |

:::caution
这个文件以明文包含供应商 API key。别提交进版本库，也别放进共享文件夹。注意启用[同步](/zh/docs/guides/sync/)会把这个文件复制到你的同步目录。
:::
