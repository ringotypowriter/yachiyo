---
title: channels.toml 参考
description: ~/.yachiyo/channels.toml 里的每个键 —— 平台凭据、群讨论调参和访客隐私。
---

`~/.yachiyo/channels.toml` 装着频道凭据和调参，与 [`config.toml`](/zh/docs/reference/config-toml/) 分开存放，机器人 token 永远不会和其他设置混在一起。

这里的键是 `snake_case`，和 `config.toml` 不同。

:::caution
这个文件以明文存放机器人 token 和客户端密钥，而且和供应商 API key 不同，它们在命令行输出中**不会**被打码。把它当作凭据库对待。
:::

## `[telegram]`

| 键                             | 类型      | 说明                        |
| ------------------------------ | --------- | --------------------------- |
| `enabled`                      | `boolean` | Telegram 机器人是否运行     |
| `bot_token`                    | `string`  | @BotFather 给的 token       |
| `model_provider`、`model_name` | `string`  | Telegram 线程的可选模型覆盖 |
| `[telegram.group]`             | table     | 群讨论设置 —— 见下          |

## `[qq]`

NapCatQQ over OneBot v11。

| 键                             | 类型      | 说明                                              |
| ------------------------------ | --------- | ------------------------------------------------- |
| `enabled`                      | `boolean` | QQ 机器人是否运行                                 |
| `ws_url`                       | `string`  | NapCatQQ 正向 WebSocket，如 `ws://localhost:3001` |
| `token`                        | `string`  | WS 连接的可选鉴权 token                           |
| `model_provider`、`model_name` | `string`  | 可选模型覆盖                                      |
| `[qq.group]`                   | table     | 群讨论设置                                        |

## `[discord]`

| 键                             | 类型      | 说明                         |
| ------------------------------ | --------- | ---------------------------- |
| `enabled`                      | `boolean` | Discord 机器人是否运行       |
| `bot_token`                    | `string`  | Discord 开发者门户给的 token |
| `model_provider`、`model_name` | `string`  | 可选模型覆盖                 |
| `[discord.group]`              | table     | 服务器文字频道的群讨论设置   |

## `[qqbot]`

QQ 官方 Bot API。**仅私聊** —— 没有群支持。

| 键                             | 类型      | 说明                  |
| ------------------------------ | --------- | --------------------- |
| `enabled`                      | `boolean` | QQ 官方机器人是否运行 |
| `app_id`                       | `string`  | QQ 开放平台的 App ID  |
| `client_secret`                | `string`  | 客户端密钥            |
| `model_provider`、`model_name` | `string`  | 可选模型覆盖          |

## `[<platform>.group]`

按平台的群讨论设置。`telegram`、`qq` 和 `discord` 都有。

| 键                                                               | 类型      | 默认     | 说明                         |
| ---------------------------------------------------------------- | --------- | -------- | ---------------------------- |
| `enabled`                                                        | `boolean` | ——       | 该平台上是否运行群讨论       |
| `model_provider`、`model_name`                                   | `string`  | 工具模型 | 群探针使用的模型             |
| `vision`                                                         | `boolean` | `false`  | 把群里的图片传给探针模型     |
| `active_check_interval_ms`                                       | `number`  | `60000`  | 活跃阶段的探针间隔           |
| `engaged_check_interval_ms`                                      | `number`  | `30000`  | 参与阶段的探针间隔           |
| `wake_buffer_ms`                                                 | `number`  | `60000`  | 有新活动时唤醒前的延迟       |
| `dormancy_miss_count`                                            | `number`  | `3`      | 掉回休眠前的静默检查次数     |
| `disengage_miss_count`                                           | `number`  | `3`      | 离开参与状态前的静默检查次数 |
| `probe_adapter`、`probe_adapter_provider`、`probe_adapter_model` | `string`  | ——       | 无头探针适配器覆盖           |

## `[privacy]`

| 键                       | 类型       | 说明                                     |
| ------------------------ | ---------- | ---------------------------------------- |
| `guest_instruction`      | `string`   | 注入到访客对话系统提示词里的自定义上下文 |
| `memory_filter_keywords` | `string[]` | 含这些关键词的记忆结果对访客隐藏         |

## `[image_to_text]`

| 键        | 类型      | 默认    | 说明                               |
| --------- | --------- | ------- | ---------------------------------- |
| `enabled` | `boolean` | `false` | 预先把群消息里的图片描述成替代文本 |

## 全局群设置

跨平台生效的顶层键；两边都设了的时候，按平台的值胜出。

| 键                                             | 类型     | 默认                         | 说明                                                         |
| ---------------------------------------------- | -------- | ---------------------------- | ------------------------------------------------------------ |
| `verbosity`                                    | `number` | `0`                          | 发言节流：`0` 是正常曲线，`1` 从不节流                       |
| `check_interval_ms`                            | `number` | ——                           | 活跃阶段探针间隔的全局覆盖                                   |
| `dm_compact_token_threshold_k`                 | `number` | `64`                         | 私聊上下文预算，单位千 token                                 |
| `group_context_window_k`                       | `number` | `64`                         | 群探针滑动窗口，单位千 token                                 |
| `group_handoff_threshold_k`                    | `number` | `2 × group_context_window_k` | 探针线程超过这个大小后，较早的记录会被总结成滚动交接         |
| `rewrite_model_provider`、`rewrite_model_name` | `string` | ——                           | 把发出的群回复改写成人格语气的模型。不设则按生成的原样发出。 |

交接阈值的下限是上下文窗口的两倍 —— 那段空隙就是迟滞，好让一个长期运行的群不会每一轮都重新总结。

## 另见

- [频道](/zh/docs/guides/channels/) —— 配置与访客模型
- [`yachiyo channel`](/zh/docs/cli/channel/) —— 查看用户和群组
