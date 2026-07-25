---
title: yachiyo soul
description: 列出、添加和移除 SOUL.md 里演化中的人格特质。
---

`~/.yachiyo/SOUL.md` 定义助手的人格。它的 `traits` 小节存放随时间累积的演化观察 —— 这个命名空间编辑的就是那个列表。

## `soul traits list`

```bash
yachiyo soul traits list
```

以 JSON 数组打印当前所有特质，每项是 `{ key, trait }`。`key` 是一个稳定的哈希，传给 `remove` 用。

## `soul traits add`

```bash
yachiyo soul traits add "<trait text>"
```

追加一条特质，归到 `SOUL.md` 里今天的日期标题下。返回更新后的列表。

```bash
yachiyo soul traits add "States the tradeoff before the recommendation"
```

## `soul traits remove`

```bash
yachiyo soul traits remove <key>
```

按哈希键移除一条特质 —— 也就是 `soul traits list` 返回的 `key` 字段，不是序号，也不是文本本身。返回更新后的列表。

## 使用另一个灵魂文件

```bash
yachiyo soul traits list --soul /path/to/SOUL.md
```

## 另见

- [记忆与人格](/zh/docs/guides/memory-and-persona/) —— `SOUL.md`、`USER.md` 和记忆的区别
