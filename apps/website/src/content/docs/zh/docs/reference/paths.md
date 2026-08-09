---
title: 文件与路径
description: ~/.yachiyo 下都有什么，以及如何用 YACHIYO_HOME 把它挪走。
---

八千代持久化的数据文件都在同一个目录里。macOS 默认是 `/Users/<你>/.yachiyo`，Windows 默认是 `C:\Users\<你>\.yachiyo`。操作系统的凭据加密会保护本机模型供应商凭据库的密钥；没有八千代服务器留着一份副本。

## `~/.yachiyo`

| 路径                              | 是什么                                                                                              |
| --------------------------------- | --------------------------------------------------------------------------------------------------- |
| `config.toml`                     | 设置和供应商元数据；不含模型供应商密钥，但可能包含 Exa key。[参考](/zh/docs/reference/config-toml/) |
| `provider-credentials.enc`        | 加密后的模型供应商 API key 和 Vertex 私钥                                                           |
| `provider-credentials.key`        | 由操作系统凭据加密封装的凭据库密钥                                                                  |
| `channels.toml`                   | 频道凭据与调参。[参考](/zh/docs/reference/channels-toml/)                                           |
| `yachiyo.sqlite`                  | 线程、消息、工具调用、记忆、定时任务、运行历史                                                      |
| `SOUL.md`                         | 助手人格与演化中的特质日志                                                                          |
| `USER.md`                         | 你的档案，以结构化表格记录                                                                          |
| `skills/core/`                    | 内置技能。每次启动重新解压 —— 改动会丢失。                                                          |
| `skills/custom/`                  | 你自己的技能                                                                                        |
| `bin/yachiyo` / `bin/yachiyo.cmd` | 对应平台的命令行包装脚本。每次启动重新生成；不要编辑。                                              |
| `yachiyo.sock`                    | macOS 上实时命令使用的 Unix socket；Windows 改用 named pipe                                         |
| `temp-workspace/<thread-id>/`     | 为没有分配目录的线程自动创建的工作区                                                                |
| `file-history/`                   | 运行的文件快照（内容寻址）                                                                          |
| `workspace-indexes/`              | 已注册工作区的搜索索引                                                                              |
| `web-search/browser-session/`     | 搜索使用的隐藏浏览器会话                                                                            |
| `browser-automation/`             | `useBrowser` 的会话和配置文件                                                                       |
| `jotdowns/`                       | 用速记快捷键记下的短笔记                                                                            |
| `activity-source.key`             | 活动来源的密钥                                                                                      |

## `YACHIYO_HOME`

设置 `YACHIYO_HOME` 可以整个目录搬家：

```bash
YACHIYO_HOME=/tmp/yachiyo-test yachiyo thread list
```

```powershell
$env:YACHIYO_HOME = 'D:\Yachiyo Test'
yachiyo thread list
```

上面的一切会一起挪走 —— 配置、数据库、技能，以及命令端点的身份。Windows 不创建 socket 文件，而是从规范化后的主目录生成稳定的 `\\.\pipe\yachiyo-<id>`。想跑一个隔离实例做测试又不碰真实历史，这是最干净的做法。

命令行也可以只指向单个文件，想读一份数据库副本而不动其他东西时很方便：

```bash
yachiyo thread list --db /path/to/yachiyo.sqlite
yachiyo config get --settings /path/to/config.toml
yachiyo soul traits list --soul /path/to/SOUL.md
```

## 该备份什么

| 优先级 | 路径                                                                                           | 为什么                                      |
| ------ | ---------------------------------------------------------------------------------------------- | ------------------------------------------- |
| 高     | `yachiyo.sqlite`                                                                               | 你的全部对话历史                            |
| 高     | `SOUL.md`、`USER.md`                                                                           | 人格与档案 —— 很小，但重建起来很慢          |
| 高     | `skills/custom/`                                                                               | 你写的技能                                  |
| 中     | `config.toml`                                                                                  | 设置；可能含 Exa 网页搜索 key。请保持私密。 |
| 中     | `provider-credentials.enc`、`provider-credentials.key`                                         | 本机供应商密钥；换设备后需要重新配置。      |
| 中     | `channels.toml`                                                                                | 机器人凭据。请保持私密。                    |
| 跳过   | `temp-workspace/`、`file-history/`、`workspace-indexes/`、`web-search/`、`browser-automation/` | 可再生成，而且很大                          |

## 什么会离开你的机器

只有你引发的那些请求：发给你自己配置的供应商的调用、智能体抓取的页面、你执行的搜索，以及频道消息。没有遥测，也没有托管后端。

[同步](/zh/docs/guides/sync/)是唯一的例外，而且它需要主动开启并指向一个你自己选的文件夹。它会把 `config.toml` 中的设置数据和聊天存档复制进去；供应商凭据库及其密钥只留在本设备。由于 `config.toml` 仍可能包含 Exa key 等其他密钥，同步目录也应保持私密。
