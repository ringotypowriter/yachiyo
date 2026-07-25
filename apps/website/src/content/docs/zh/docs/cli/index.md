---
title: 命令行总览
description: yachiyo 命令 —— 命名空间、全局参数，以及找不到命令时怎么办。
---

`yachiyo` 命令驱动的是桌面应用用的那同一个本地实例。它大部分直接读写 `~/.yachiyo`，所以应用开没开都能用 —— 例外是 `send`，它需要一个活着的应用。

```
yachiyo <namespace> <subcommand> [args...] [flags...]
```

除非命令另有说明，输出都是 JSON。`yachiyo <namespace> --help` 会打印任意命名空间的详细帮助。

:::tip[这主要是智能体的控制面]
八千代默认启用 `yachiyo-help` 技能，它记录了下面每一条命令。也就是说，当你用大白话提要求时 —— 建一个定时任务、批准一个频道用户、整理模型列表 —— 助手可以自己去跑这些命令。

想把它写进脚本、CI 步骤或 shell 管道时，才直接上命令行。一次性的改动，开口问比手写 JSON 载荷更快也更不容易出错。
:::

## 命名空间

| 命名空间                                | 用途                               |
| --------------------------------------- | ---------------------------------- |
| [`soul`](/zh/docs/cli/soul/)         | 管理演化中的人格特质               |
| [`provider`](/zh/docs/cli/provider/) | 管理 AI 供应商和模型               |
| [`agent`](/zh/docs/cli/agent/)       | 子智能体运行模式与 ACP 档案        |
| [`config`](/zh/docs/cli/config/)     | 读写配置项                         |
| [`thread`](/zh/docs/cli/thread/)     | 搜索和查看对话历史                 |
| [`schedule`](/zh/docs/cli/schedule/) | 管理定时任务和运行历史             |
| [`channel`](/zh/docs/cli/channel/)   | 列出频道用户和群组，设置状态与标签 |
| [`send`](/zh/docs/cli/send/)         | 发送通知和频道消息                 |

## 全局参数

| 参数                | 默认                        | 说明                         |
| ------------------- | --------------------------- | ---------------------------- |
| `--settings <path>` | `~/.yachiyo/config.toml`    | 设置文件路径                 |
| `--soul <path>`     | `~/.yachiyo/SOUL.md`        | 灵魂文档路径                 |
| `--db <path>`       | `~/.yachiyo/yachiyo.sqlite` | 数据库文件路径               |
| `--payload <json>`  | ——                          | 变更类命令的 JSON 请求体     |
| `--limit <n>`       | 5                           | 列表类命令的最大结果数       |
| `--json`            | 关                          | 输出原始 JSON 而不是可读文本 |
| `--help`            | ——                          | 某个命令或命名空间的帮助     |

有些命令会覆盖 limit 的默认值 —— `thread list` 用 10，`schedule runs` 用 20。

路径参数的存在是为了让你把命令行指向一个隔离的环境。设置 `YACHIYO_HOME` 可以一次性把三个都挪过去，通常更省事。

## 输出中的密钥

每条命令在打印之前都会把 `apiKey` 的值替换成 `***`，`yachiyo config get` 也不例外。直接读 `config.toml` 是唯一能打印出供应商 key 的方式。

`channels.toml` 里的频道机器人 token **不在**这个打码范围内。

## 写脚本

`--json` 让所有东西都变成机器可读的：

```bash
# 最近更新的线程，JSON 格式
yachiyo thread list --limit 20 --json | jq '.[] | .title'

# 长时间构建结束时通知自己
make release && yachiyo send notification "Release build done" --title "CI"
```

## `command not found`

先问八千代：

> 终端里找不到 `yachiyo` 命令，修一下。

它的 help 技能里有完整的排查路径，也有 shell 权限去执行，包括改你的 shell 配置文件。应用不在你的 PATH 里，并不妨碍这个应用去修你的 PATH。

<details>
<summary>自己排查</summary>

桌面应用每次启动都会写入 `~/.yachiyo/bin/yachiyo`，然后尝试让它可被调用。这一步没成功的时候，按下面这个清单往下走。

**1. 包装脚本存在吗？**

```bash
ls -la ~/.yachiyo/bin/yachiyo
```

不存在说明应用还没生成它 —— 重启八千代。

**2. 软链在吗？**

```bash
ls -la /usr/local/bin/yachiyo
```

如果没有，检查这个目录是否存在且可写：

```bash
ls -ld /usr/local/bin
```

你可以手动建这个链接：

```bash
sudo mkdir -p /usr/local/bin
sudo ln -sf ~/.yachiyo/bin/yachiyo /usr/local/bin/yachiyo
```

**3. `~/.yachiyo/bin` 在你的 PATH 里吗？**

```bash
echo $PATH | tr ':' '\n' | grep yachiyo
```

不在的话，应用启动时会把它加进你的 shell 配置文件 —— 检查 `~/.zshrc`、`~/.bashrc` / `~/.bash_profile`，或者 `~/.config/fish/config.fish`。自己加的话：

```bash
export PATH="$HOME/.yachiyo/bin:$PATH"     # zsh / bash
```

```fish
fish_add_path ~/.yachiyo/bin               # fish
```

无论哪种方式，都需要开一个新终端，或者 source 一下配置文件。

</details>

:::note
包装脚本每次应用启动都会重新生成，指向正在运行的那个应用包。不要改它。
:::
