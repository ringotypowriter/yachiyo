---
title: yachiyo provider
description: 列出、查看和更新 AI 供应商，并设定新对话的默认模型。
---

管理 `~/.yachiyo/config.toml` 中的供应商定义。API key 和 Vertex 私钥存放在本机加密的供应商凭据库中。所有输出里的 API key 都会打码成 `***`。

## `provider list`

```bash
yachiyo provider list
```

列出所有已配置的供应商，key 已打码。

## `provider show`

```bash
yachiyo provider show <id-or-name>
```

完整展示一个供应商，用 UUID 或显示名称寻址。

## `provider update`

```bash
yachiyo provider update <id-or-name> [--payload '<json>']
```

把一个 JSON 补丁合并进已有的供应商。只有你提供的字段会变。

```bash
yachiyo provider update my-openai --payload '{"apiKey":"sk-..."}'
yachiyo provider update my-openai --payload '{"baseUrl":"https://proxy.internal/v1"}'
```

提供 `apiKey` 或 Vertex 私钥时，它会写入当前设备的加密凭据库。供应商凭据不会同步，因此每台设备都需要单独配置。

## `provider set-default`

```bash
yachiyo provider set-default <id-or-name> [--model <model>]
```

把该供应商提到默认位置，并设定新对话使用的模型 —— 一步之内同时更新供应商排序和 `defaultModel` 设置。不带 `--model` 时，取该供应商第一个已启用的模型。

```bash
yachiyo provider set-default anthropic --model <model-name>
```

## `provider models`

```bash
yachiyo provider models                 # 本地已启用的模型
yachiyo provider models <id-or-name>    # 该供应商 API 提供的一切
```

不带参数时，你会得到一个扁平数组，每项是 `{ provider, model }`，覆盖你启用的每个模型 —— 也就是定时任务载荷和常用入口预设里 `modelOverride` 字段的合法取值。

带上供应商参数时，它会调用该供应商的 API 并列出实际可用的模型，这是你发现值得启用的模型名的方式。

:::tip
写进载荷之前先把模型名查出来。猜一个模型字符串，换来的是一次在请求时才失败的运行，而不是在配置时就报错。
:::

## 另见

- [供应商与模型](/zh/docs/guides/providers/) —— 这些命令背后的概念
- [`yachiyo config`](/zh/docs/cli/config/) —— 这些命令覆盖不到的设置
