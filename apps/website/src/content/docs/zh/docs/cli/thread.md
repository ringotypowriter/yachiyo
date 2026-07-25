---
title: yachiyo thread
description: 搜索消息历史、列出近期线程，并导出完整对话。
---

直接从本地 SQLite 数据库读取对话历史 —— 不需要应用在运行。访客频道的线程不会出现在结果里。

开启了隐私模式的线程在这三条命令里都会被隐藏，除非你传 `--include-private`。

## `thread search`

```bash
yachiyo thread search <query> [--limit <n>] [--json] [--include-private]
```

跨消息历史的全文搜索，在 FTS 索引可用时按 BM25 相关度排序。

默认输出是纯文本，一行一条匹配：

```
[ThreadID: abc123] 2026-03-15 Role: user Content: …found the relevant text here…
[ThreadID: def456] 2026-03-10 Role: model Content: …here is what I suggested…
```

| 参数                | 默认 | 说明                   |
| ------------------- | ---- | ---------------------- |
| `--limit <n>`       | 5    | 最多返回多少条匹配消息 |
| `--json`            | 关   | 原始 JSON 数组         |
| `--include-private` | 关   | 包含隐私模式的线程     |

```bash
yachiyo thread search "deployment steps"
yachiyo thread search "api key" --limit 10
yachiyo thread search "auth" --json
```

### 排序是怎么算的

索引用的是 trigram 分词，所以它处理中日韩等不以空格分词的文字，和处理英文一样好。多词查询以 OR 连接 —— 任何命中的 token 都会给分数做贡献。

短于三个字符的查询回落到 `LIKE` 子串匹配；索引缺失或不可读时（应用从没启动过的首次运行，或者一份只读的数据库副本）整条命令也会这样回落。回落的结果按线程时间新旧排序，而不是相关度。

## `thread list`

```bash
yachiyo thread list [--limit <n>] [--json] [--include-private]
```

近期未归档的线程，按活动时间从新到旧。每条带标题、第一句用户提问、消息数和复核状态。

```
[thread-a] Planning session (12 msgs) q: how do we plan Q2?
[thread-b] [reviewed] Bug triage (8 msgs) q: what's failing in CI?
```

| 参数                | 默认 | 说明               |
| ------------------- | ---- | ------------------ |
| `--limit <n>`       | 10   | 最多返回多少个线程 |
| `--json`            | 关   | 原始 JSON 数组     |
| `--include-private` | 关   | 包含隐私模式的线程 |

## `thread show`

```bash
yachiyo thread show <id> [--json] [--include-private]
```

按时间顺序导出一个线程里的每条消息，包括工具调用历史。显示完之后，它会尽力向运行中的应用发一条通知，把该线程标记为已复核。

```
Thread thread-a: Planning session
Created: 2026-04-05  Updated: 2026-04-07  Messages: 2  Tool calls: 1

── user @ 2026-04-05 08:00 ──
hello

── model @ 2026-04-05 08:00 ──
hi there

── tool calls ──
#1 skillsRead [completed] names=["release-process"]
```

加上 `--json` 得到完整导出，其中含一个 `toolCalls[]` 数组 —— 工具名、状态、输入输出摘要、错误和步骤序号。当你在琢磨一次运行怎么跑歪的时候，因果关系就在那个数组里。

## 指向另一个数据库

```bash
yachiyo thread list --db /path/to/other/yachiyo.sqlite
```

对着一个隔离的 `YACHIYO_HOME` 环境或一份数据库副本用起来很方便。
