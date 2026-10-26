---
title: yachiyo remote
description: 通过正在运行的桌面应用查看远程状态、管理 Cloudflare 隧道和撤销手机配对。
---

这些命令连接正在运行的桌面应用，输出 JSON。执行前请先启动八千代。Connect 激活和手机配对在 **设置 → 远程** 中完成，操作步骤见[远程访问指南](/zh/docs/guides/remote/)。

## `remote status`

```bash
yachiyo remote status
```

| 字段          | 含义                                                                 |
| ------------- | -------------------------------------------------------------------- |
| `enabled`     | 保存的设置是否开启了远程访问                                         |
| `running`     | 本地远程服务是否正在监听                                             |
| `tunnel`      | `relay`、`quick`、`named` 或 `none`                                  |
| `port`        | 当前监听端口；服务停止时为 `null`                                    |
| `endpoints`   | 公布的隧道、外部或局域网地址                                         |
| `relay`       | Connect 的激活状态、连接状态和服务地址                               |
| `cloudflared` | 可执行文件路径、托管进程状态、域名，以及用户配置是否阻止快速隧道启动 |
| `icloudDrive` | `available` 或 `unavailable`；地址恢复只支持 macOS                   |
| `pairings`    | 已保存的手机配对数量                                                 |
| `connections` | 当前手机连接数量                                                     |

使用 Connect 时检查 `relay.connected`，它的公网路由不在 `endpoints` 中。`running` 只表示本地服务正在监听。隧道进程正在运行或已保存域名，都不能证明公网可达；请在手机上验证。

## `remote tunnel install`

安装或替换托管的 Cloudflare 隧道，并开启远程访问。命令返回当前状态；地址发现可能稍后才完成。等到地址出现后再配对。

先按 [Cloudflare 下载指南](https://developers.cloudflare.com/tunnel/downloads/)安装 `cloudflared`。macOS 上可以让内置 `yachiyo-remote` 技能先准备 HTTP/2 和自动恢复守护进程，再安装隧道。Windows 上需要让应用通过 `PATH` 找到 `cloudflared.exe`，安装后重启八千代。

### 快速隧道

```bash
yachiyo remote tunnel install --mode quick
```

不需要 Cloudflare 账号，使用临时地址。隧道进程重启后地址可能变化。如果存在 `~/.cloudflared/config.yaml`，安装会失败；请使用命名隧道，不要删除这个文件。

### 命名隧道

先按 Cloudflare 的[本地管理隧道指南](https://developers.cloudflare.com/tunnel/features/locally-managed-tunnels/create-local-tunnel/)创建命名隧道和 DNS 路由。入口配置和隧道进程由八千代管理。隧道和路由准备好后，执行：

```bash
yachiyo remote tunnel install --mode named --tunnel <name> --hostname <host>
```

填写已有隧道的名称和对应域名，例如 `remote.example.com`。两个参数都必填。八千代会写入自己的入口配置，不会替换用户级 Cloudflare 配置。

macOS 使用用户级 LaunchAgent 运行隧道。Windows 由桌面应用管理进程，退出应用时停止。Linux 不支持这两个安装命令，请使用 Connect 或[外部连接地址](/zh/docs/guides/remote/#外部连接地址与局域网)。

重新安装会替换当前隧道进程，短暂中断访问。修复已有配置时，保留原来的模式、隧道名称和域名。重新安装不会撤销手机配对；但如果快速隧道地址发生变化，需要通过地址恢复重新连接，或生成新配对码。

## `remote tunnel uninstall`

```bash
yachiyo remote tunnel uninstall
```

停止并移除托管隧道，将 `tunnel` 改为 `none`。远程服务仍然开启，配对记录也会保留。已配置的外部地址或局域网访问仍可能可用。它不会移除你在八千代之外管理的隧道。

要停止所有远程连接，请在设置中关闭**远程访问**并保存。

## `remote pairings list`

```bash
yachiyo remote pairings list
```

返回已配对手机列表。每条记录包含 `pairingId`、`deviceName`、`createdAt`，以及可选的 `lastSeenAt`。撤销访问时使用 `pairingId`。

## `remote pairings revoke`

```bash
yachiyo remote pairings revoke <pairingId>
```

撤销这台手机的访问权限，并立即断开连接。响应里的 `revoked` 是布尔值。手机需要新的配对码才能再次连接。

连接方式、地址恢复和通知设置见[远程访问](/zh/docs/guides/remote/)，保存的设置见 [`[remote]`](/zh/docs/reference/config-toml/#remote)。
