---
title: 安装
description: 下载八千代、首次启动，并把 yachiyo 命令行接进你的 PATH。
---

## 环境要求

八千代支持 macOS 和 Windows 11 x64。Windows 10、Windows ARM 和 Linux 不是发布目标。

你还需要至少一家模型供应商的 API key。八千代不自带模型，也没有托管账号 —— 见[供应商与模型](/zh/docs/guides/providers/)。

## 下载

从 [Releases 页面](https://github.com/ringotypowriter/yachiyo/releases)下载对应平台的文件：

- **macOS：**打开 macOS 发布包，把 **Yachiyo** 放进 `/Applications`。
- **Windows 11 x64：**运行 `yachiyo-<version>-setup.exe`。

Windows 安装包刻意不做代码签名，因此系统会显示 **Unknown publisher（未知发布者）**。继续之前先确认文件名和下载来源确实是八千代的官方 Release。这个提示是预期行为，不代表安装包伪装成了受信任发布者。

## 首次启动

首次启动时，八千代会创建自己的主目录并写入数据。macOS 默认是 `~/.yachiyo`，Windows 默认是 `C:\Users\<你>\.yachiyo`。

- `config.toml` —— 供应商、工具、技能、记忆和网页搜索设置
- `channels.toml` —— Telegram / QQ / Discord 凭据，与 `config.toml` 分开存放，机器人 token 不会和其他设置混在一起
- `yachiyo.sqlite` —— 所有线程和消息，存在本地
- `skills/core/` —— 内置核心技能，每次应用更新时重新解压
- macOS 上的 `bin/yachiyo` 或 Windows 上的 `bin/yachiyo.cmd` —— 命令行包装脚本

一个引导浮层会带你接上供应商。想自己来的话，直接看[快速上手](/zh/docs/quickstart/)。

:::note[换一个主目录]
设置 `YACHIYO_HOME` 可以把整个数据目录挪到别处。想开一个隔离的测试环境又不碰真实历史记录，这是最干净的做法。例如 PowerShell 可以先执行 `$env:YACHIYO_HOME = 'D:\Yachiyo Test'` 再启动八千代。
:::

## 命令行

桌面应用每次启动都会刷新对应平台的包装脚本：

- **Windows：**`~/.yachiyo/bin/yachiyo.cmd` 调用已安装的 `yachiyo.exe`。应用会以当前用户身份把这一个目录加入用户 `PATH`，不需要管理员权限。
- **macOS：**`~/.yachiyo/bin/yachiyo` 按下面的方式安装：

1. 它会把 `/usr/local/bin/yachiyo` 软链到这个包装脚本。成功的话，新开的任何 shell 里都能直接用。
2. 如果软链创建不了 —— `/usr/local/bin` 不存在、不可写，或者已经被一个真实文件占了 —— 它会转而把 `~/.yachiyo/bin` 追加到你的 shell 配置里（zsh、bash 和 fish 都处理）。

无论哪个平台，`PATH` 变化后都要**新开一个 PowerShell、命令提示符、内置 Bash 或其他终端会话**才会生效。

验证一下：

```bash
yachiyo doctor --json
```

如果提示 `command not found`，修法见[命令行总览](/zh/docs/cli/#command-not-found)。

:::caution
包装脚本每次启动都会重新生成，指向你当前运行的安装。不要改它 —— 下次八千代启动时你的改动就没了。
:::

## 开机自启（仅 macOS）

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

使用应用内更新，或安装新版发布文件。macOS 替换 `/Applications` 里的应用；Windows 运行新版 `.exe`。更新不会碰八千代主目录 —— 设置、历史记录、工作区和自定义技能都会保留。`skills/core/` 下的内置核心技能每次启动都会重新解压，所以对它们的本地修改不会保留；自己写的东西请放进 `skills/custom/`。

## 在 Windows 上卸载

从 Windows 设置卸载八千代。卸载程序会删除已安装的应用、自动生成的 `yachiyo.cmd`，并且只移除八千代自己的那一条用户 `PATH`；它会保留 `C:\Users\<你>\.yachiyo`，让设置、数据库、工作区和自定义技能仍可恢复。只有在你也想清除数据时，才自行删除这个目录。

## 从源码构建

```bash
nvm use
pnpm install
pnpm dev
```

仓库是一个 pnpm workspace：`apps/desktop`（Electron 应用）、`packages/runtime`（助手运行时）、`packages/cli`、`packages/shared` 和 `packages/core-skills`。
