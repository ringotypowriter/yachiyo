---
title: 安装
description: 下载八千代、首次启动，并把 yachiyo 命令行接进你的 PATH。
---

## 环境要求

只支持 macOS。没有 Windows 和 Linux 版本，也没有这个计划。

你还需要至少一家模型供应商的 API key。八千代不自带模型，也没有托管账号 —— 见[供应商与模型](/zh/docs/guides/providers/)。

## 下载

从 [Releases 页面](https://github.com/ringotypowriter/yachiyo/releases)下载最新的 `.dmg`，打开后把 **Yachiyo** 拖进 `/Applications`。

## 首次启动

首次启动时，八千代会创建它的主目录 `~/.yachiyo`，并写入：

- `config.toml` —— 供应商、工具、技能、记忆和网页搜索设置
- `channels.toml` —— Telegram / QQ / Discord 凭据，与 `config.toml` 分开存放，机器人 token 不会和其他设置混在一起
- `yachiyo.sqlite` —— 所有线程和消息，存在本地
- `skills/core/` —— 内置核心技能，每次应用更新时重新解压
- `bin/yachiyo` —— 命令行包装脚本

一个引导浮层会带你接上供应商。想自己来的话，直接看[快速上手](/zh/docs/quickstart/)。

:::note[换一个主目录]
设置 `YACHIYO_HOME` 可以把整个数据目录挪到别处。想开一个隔离的测试环境又不碰真实历史记录，这是最干净的做法。
:::

## 命令行

桌面应用每次启动都会写入 `~/.yachiyo/bin/yachiyo`，然后尝试让它可被调用：

1. 它会把 `/usr/local/bin/yachiyo` 软链到这个包装脚本。成功的话，新开的任何 shell 里都能直接用。
2. 如果软链创建不了 —— `/usr/local/bin` 不存在、不可写，或者已经被一个真实文件占了 —— 它会转而把 `~/.yachiyo/bin` 追加到你的 shell 配置里（zsh、bash 和 fish 都处理）。

无论哪种方式，都需要**开一个新的终端会话**命令才会生效。

验证一下：

```bash
yachiyo thread list --limit 3
```

如果提示 `command not found`，修法见[命令行总览](/zh/docs/cli/#command-not-found)。

:::caution
包装脚本每次启动都会重新生成，指向你当前运行的那个应用包。不要改它 —— 下次八千代启动时你的改动就没了。
:::

## 开机自启

定时任务、频道机器人和 `yachiyo send` 都要求八千代处于运行状态。所以，让它自己去安排：

> 开机登录时自动启动你自己。

它知道怎么做 —— 内置的 `yachiyo-help` 技能里就有 LaunchAgent 的配方，而它有 shell 权限去写入并加载这个文件。让它事后自查一下，它会确认 agent 是否注册成功。

这里几乎所有机械性的事情，都该用这种方式做。你不是在配置一个工具；你是在吩咐一个已经能读自己文档、并且能在你机器上动手的助手。

<details>
<summary>如果你更想手动来</summary>

写入 LaunchAgent：

```xml title="~/Library/LaunchAgents/sh.ringo.yachiyo.plist"
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>sh.ringo.yachiyo</string>
    <key>ProgramArguments</key>
    <array>
        <string>/usr/bin/open</string>
        <string>/Applications/Yachiyo.app</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
</dict>
</plist>
```

然后加载并确认：

```bash
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/sh.ringo.yachiyo.plist
launchctl list | grep sh.ringo.yachiyo
```

</details>

## 更新

下载新的 `.dmg`，替换 `/Applications` 里的应用即可。更新不会碰你的 `~/.yachiyo` 目录 —— 设置、历史记录和自定义技能都会保留。`skills/core/` 下的内置核心技能每次启动都会重新解压，所以对它们的本地修改不会保留；自己写的东西请放进 `skills/custom/`。

## 从源码构建

```bash
nvm use
pnpm install
pnpm dev
```

仓库是一个 pnpm workspace：`apps/desktop`（Electron 应用）、`packages/runtime`（助手运行时）、`packages/cli`、`packages/shared` 和 `packages/core-skills`。
