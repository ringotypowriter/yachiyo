---
title: 供应商与模型
description: 接入模型供应商，挑选出现在选择器里的模型，并配置工具模型与推理强度。
---

八千代没有内置模型，也没有托管账号。供应商由你提供，而且想接多少家都行 —— 逐条消息切换是常规用法，不是边缘情况。

供应商配置在 `~/.yachiyo/config.toml` 里。API key 以明文存在你自己的机器上，并且在所有命令行输出中都会被打码。

## 添加一个供应商

**设置 → 供应商 → 添加**，然后选一个预设。预设会填好 API 类型和 base URL，你提供 key。

| 预设                 | API 类型         | Base URL                                            |
| -------------------- | ---------------- | --------------------------------------------------- |
| Anthropic            | `anthropic`      | `https://api.anthropic.com/v1`                      |
| OpenAI               | `openai`         | `https://api.openai.com/v1`                         |
| OpenAI (Codex OAuth) | `openai-codex`   | `https://chatgpt.com/backend-api/codex`             |
| Gemini               | `gemini`         | `https://generativelanguage.googleapis.com/v1beta`  |
| Google Vertex AI     | `vertex`         | ——（使用 project + location）                       |
| Vercel AI Gateway    | `vercel-gateway` | `https://ai-gateway.vercel.sh/v3/ai`                |
| OpenRouter           | `openai`         | `https://openrouter.ai/api/v1`                      |
| DeepSeek             | `openai`         | `https://api.deepseek.com/v1`                       |
| Moonshot             | `openai`         | `https://api.moonshot.cn/v1`                        |
| Kimi For Coding      | `anthropic`      | `https://api.kimi.com/coding/v1`                    |
| 智谱 GLM             | `anthropic`      | `https://open.bigmodel.cn/api/anthropic`            |
| Z.ai                 | `anthropic`      | `https://api.z.ai/api/anthropic`                    |
| Minimax              | `openai`         | `https://api.minimaxi.com/v1`                       |
| Mistral              | `openai`         | `https://api.mistral.ai/v1`                         |
| 阿里云百炼           | `openai`         | `https://dashscope.aliyuncs.com/compatible-mode/v1` |
| PackyCode            | `anthropic`      | `https://www.packyapi.com/v1`                       |
| Ollama               | `openai`         | `http://localhost:11434/v1`                         |

不在列表上的也能用 —— 挑一个 API 形状匹配的预设（大多数第三方端点要么兼容 OpenAI，要么兼容 Anthropic），然后替换 base URL。

### 本地模型

**Ollama** 预设指向 `http://localhost:11434/v1`，不需要 API key。其他任何兼容 OpenAI 的本地服务（llama.cpp、LM Studio、vLLM）也一样 —— 设好 base URL，如果服务端不校验就把 key 留空。

### Vertex AI

Vertex 不用 API key。它需要的是 `project`、`location`，以及一个服务账号（`serviceAccountEmail` + `serviceAccountPrivateKey`）。

### Codex OAuth

`openai-codex` 类型通过 Codex CLI 的会话认证，而不是 key。把 `codexSessionPath` 指向你的 Codex `auth.json`，八千代会从中读取账号。

## 挑选出现在选择器里的模型

拉取一家供应商的模型目录会返回 API 知道的一切，通常远多于你希望在选择器里看到的。所以每个供应商维护两个列表：

- `modelList.enabled` —— 出现在模型选择器里
- `modelList.disabled` —— 已知，但刻意隐藏

只有已启用的模型可选。整理一次，选择器就一直清爽。

```bash
yachiyo provider models openai      # API 那边提供的一切
yachiyo provider models             # 你实际启用了的
```

另外还有 `modelList.imageIncapable` —— 模型默认被认为可以接收图片，所以这里列的是不能的那些。

## 默认模型

`defaultModel` 决定新线程从什么开始：

```bash
yachiyo provider set-default anthropic --model <model-name>
```

这一步同时把该供应商提到默认位置并设定当前模型。不带 `--model` 时，它取该供应商第一个已启用的模型。单个线程和单条消息都可以随意覆盖。

## 工具模型

除了和你对话的那个模型之外，八千代还用一个**工具模型**做后台工作：

- 线程标题
- 记忆生成与蒸馏
- 线程超出窗口时的上下文交接
- 图转文描述
- 群聊探针与回复改写
- 内置翻译器

三种模式：

| 模式       | 行为                                     |
| ---------- | ---------------------------------------- |
| `default`  | 复用聊天模型。简单，也是最贵的选项。     |
| `custom`   | 指定具体的供应商和模型。                 |
| `disabled` | 完全跳过辅助生成。标题会很泛，蒸馏停止。 |

这些活儿频繁且低风险，所以 `custom` 指向一个又小又快的模型通常是对的配置。

```bash
yachiyo config get toolModel
yachiyo config set toolModel.mode '"custom"'
```

## 推理强度

对于暴露了推理预算的模型，每个供应商可以带一个 `reasoning` 配置块：提供哪些强度档位（`low`、`medium`、`high`、`xhigh`、`max`）、默认是哪一档、以及是否允许 `off`。之后就能在输入框里按消息选择强度。

## 从命令行管理供应商

```bash
yachiyo provider list                       # 所有供应商，key 已打码
yachiyo provider show openai                # 完整查看一个供应商
yachiyo provider update openai --payload '{"apiKey":"sk-..."}'
yachiyo provider set-default openai --model <model-name>
```

细节见 [`provider` 命令行参考](/zh/docs/cli/provider/)。

:::caution[config.toml 里的密钥]
`config.toml` 以明文存放 API key。别把它提交进版本库，也别放进共享文件夹。

命令行输出比文件本身安全：每条命令都会把 `apiKey` 的值替换成 `***`，`yachiyo config get` 也不例外。直接读文件是唯一能打印出 key 的方式。
:::
