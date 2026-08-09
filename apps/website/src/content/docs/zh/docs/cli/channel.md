---
title: yachiyo channel
description: 列出频道用户和群组、给它们打标签，并改变群组的监视状态。
---

查看在你各个频道平台上注册的用户和群组。这些命令返回的 `id` 就是 [`yachiyo send channel`](/zh/docs/cli/send/) 需要的东西。

## `channel users`

```bash
yachiyo channel users [--json]
```

紧凑输出：

```
[allowed] telegram:alice id=a1b2c3d4-...
[pending] qq:bob id=e5f6g7h8-...
```

加上 `--json` 得到完整记录：

```json
[
  {
    "id": "a1b2c3d4-...",
    "platform": "telegram",
    "externalUserId": "123456",
    "username": "alice",
    "status": "allowed",
    "role": "guest",
    "usageLimitKTokens": null,
    "usedKTokens": 42,
    "workspacePath": "/tmp/yachiyo/tg-alice"
  }
]
```

| 字段                | 说明                                      |
| ------------------- | ----------------------------------------- |
| `id`                | 内部 UUID —— 传给 `send channel` 的就是它 |
| `platform`          | `telegram`、`qq` 或 `discord`             |
| `externalUserId`    | 他们在该平台上的 ID                       |
| `username`          | 显示名称                                  |
| `status`            | `pending`、`allowed` 或 `blocked`         |
| `role`              | `owner` 或 `guest`                        |
| `usageLimitKTokens` | token 配额；`null` 表示无限               |
| `usedKTokens`       | 累计用量                                  |
| `workspacePath`     | 该用户的沙箱工作区                        |

## `channel groups`

```bash
yachiyo channel groups [--json]
```

```
[approved] discord:dev-chat id=x9y8z7w6-...
[pending] qq:test-group id=m1n2o3p4-...
```

| 字段              | 说明                               |
| ----------------- | ---------------------------------- |
| `id`              | 内部 UUID                          |
| `platform`        | `telegram`、`qq` 或 `discord`      |
| `externalGroupId` | 该群在平台上的 ID                  |
| `name`            | 显示名称                           |
| `status`          | `pending`、`approved` 或 `blocked` |
| `workspacePath`   | 该群的沙箱工作区                   |
| `createdAt`       | 该群注册的时间                     |

:::note[两套词汇]
用户是 `pending` / `allowed` / `blocked`。群组是 `pending` / `approved` / `blocked`。它们不能互换。
:::

## `channel groups set-status`

```bash
yachiyo channel groups set-status <id> <status>
```

接受的值：`approved` 或 `approval`、`pending`、`blocked` 或 `block`。

```bash
yachiyo channel groups set-status x9y8z7w6-... approval   # 开始监视
yachiyo channel groups set-status x9y8z7w6-... block      # 停止监视
```

如果应用在运行，改动会走本地命令端点立即生效 —— `approval` 马上启动群监视器，`block` 马上停掉。如果应用没在运行，则直接更新数据库记录。

这条命令只对群组有效。传一个频道**用户** ID 会以 `Unknown channel group` 失败。

## `channel users set-label` / `channel groups set-label`

```bash
yachiyo channel users set-label <id> <label>
yachiyo channel groups set-label <id> <label>
```

附加一个描述性标签。智能体正是靠标签判断一个联系人是谁、一个群是干什么的，所以「设计组每日站会」比留空强。

## 另见

- [频道](/zh/docs/guides/channels/) —— 平台配置与访客模型
- [`yachiyo send`](/zh/docs/cli/send/) —— 给这些 ID 发消息
