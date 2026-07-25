---
title: 技能
description: 八千代如何发现技能、扫描哪些目录，以及怎么写你自己的 SKILL.md。
---

一个技能就是一个装着 `SKILL.md` 的文件夹。格式就这些。没有清单文件，没有运行时，没有注册调用，也没有需要一直活着的服务进程。

智能体的上下文里只有技能的**名字和描述**。当某个看起来相关时，它才调用 `skillsRead` 把全文拉进来。所以在真正需要之前，一个技能只占你一行上下文 —— 这也是为什么你可以装几十个而不把模型淹掉。

## 技能从哪来

八千代扫描一组固定的目录。对每个已注册的工作区：

| 目录                           | 自动启用 |
| ------------------------------ | -------- |
| `<workspace>/.yachiyo/skills/` | 是       |
| `<workspace>/.codex/skills/`   | 否       |
| `<workspace>/.agents/skills/`  | 否       |
| `<workspace>/.claude/skills/`  | 否       |

以及你的主目录：

| 目录                 | 自动启用 |
| -------------------- | -------- |
| `~/.yachiyo/skills/` | 是       |
| `~/.codex/skills/`   | 否       |
| `~/.agents/skills/`  | 否       |
| `~/.claude/skills/`  | 否       |

为 Claude Code、Codex 或其他智能体工具写的技能，会在它们原本的位置被直接识别 —— 你不需要搬家也不需要转换格式。只是它们默认不启用；在 **设置 → 能力 → 技能** 里打开即可。

在八千代主目录下，两个子目录含义不同：

- `~/.yachiyo/skills/core/` —— 内置技能，**每次应用启动都会重新解压**。在这里的修改会被覆盖。
- `~/.yachiyo/skills/custom/` —— 你的。自己写的东西放这里。

两个技能重名时，先扫到的根目录胜出 —— 工作区根在主目录根之前扫描，所以一个项目可以用自己的版本盖住全局技能。扫描会跳过 `node_modules` 和版本控制目录。

## 哪些技能是启用的

不是一个单独的列表 —— 生效集合由三样东西拼出来：

1. 所有**自动启用**的技能（任何 `.yachiyo/skills` 根下的，无论在主目录还是工作区），除非它出现在 `skills.disabled` 里。
2. 加上 `skills.enabled` 里显式点名的 —— 来自 `~/.claude/skills` 之类的技能就是这样被打开的。
3. 除非输入框为某次运行覆盖了这个集合，那种情况下该覆盖就是全部真相，上面的设置一概不作数。

所以内置技能开箱即用，外部技能需要主动启用；而关掉一个内置技能的做法是把它加进 `disabled`，而不是从 `enabled` 里删掉。

**设置 → 能力 → 技能** 会列出所有可发现的技能，每个带一个开关，这是管理它们的正常方式。底层的键是：

```bash
yachiyo config get skills.enabled
yachiyo config get skills.disabled
```

## 写一个技能

开口要一个：

> 给我写一个技能，从 git log 起草发布说明。要按类型给 commit 分组，跳过内部琐碎改动。

内置的 `yachiyo-skill-creator` 技能覆盖了各项约定 —— 自定义技能放哪、触发描述怎么写、什么时候该把内容拆进参考文件 —— 所以助手产出的东西会符合这里的规矩，而不是靠猜。

这是推荐路径。不过格式简单到可以手写，下面就是它会产出的东西。

### 格式

一个目录加一个 `SKILL.md`：

```markdown title="~/.yachiyo/skills/custom/release-notes/SKILL.md"
---
name: release-notes
description: Use when drafting release notes from a git log — groups commits by type, writes user-facing summaries, and skips internal churn.
---

# Release Notes

Draft release notes from commit history.

## Process

1. Run `git log <last-tag>..HEAD --oneline` to get the range.
2. Group commits by conventional-commit type (`feat`, `fix`, `perf`).
3. Drop `chore`, `refactor`, and test-only commits — they are not user-facing.
4. Write one line per surviving commit, in the user's language, describing the
   effect rather than the implementation.

## Rules

- Never invent a change that is not in the log.
- If a commit message is too vague to summarize, read the diff.
```

frontmatter 里有两个字段要紧：

- **`name`** —— 引用这个技能时用的名字。缺省时回落到正文第一个 `#` 标题，再回落到目录名。
- **`description`** —— 缺省时回落到正文第一段。

描述是智能体在决定加载之前唯一能看到的东西，所以要把它写成一个**触发条件**，而不是一句概括。「Use when drafting release notes from a git log」值这个位置；「发布说明助手」不值。

### 配套文件

目录里的其他东西随你放 —— 参考文档、脚本、模板。在 `SKILL.md` 里用相对链接指过去：

```markdown
Read [references/tone.md](references/tone.md) before writing the summaries.
```

需要时智能体会用普通的 `read` 工具去读。这样既能让 `SKILL.md` 保持简短，又能让一个技能承载真正的深度 —— 内置技能用的就是这个套路。

如果 `SKILL.md` 本身变得非常大，`skillsRead` 会停止内联它，转而让智能体直接打开文件。把这当成一个信号：该把细节挪进参考文件了。

## 内置技能

| 技能                       | 覆盖什么                                                 |
| -------------------------- | -------------------------------------------------------- |
| `yachiyo-help`             | `yachiyo` 命令行 —— 每个命名空间，外加安装问题排查。     |
| `yachiyo-docs`             | 这份文档本身。实时读取，所以回答跟着当前版本走。         |
| `yachiyo-code`             | 编码规范参考；一个指向各任务专用指南的枢纽。             |
| `yachiyo-browser`          | 通过 `useBrowser` 工具做浏览器自动化。                   |
| `yachiyo-kagete`           | macOS 原生窗口自动化 —— 点击、输入、拖拽、截图任意应用。 |
| `yachiyo-macos-apps`       | 通过 AppleScript 操作邮件、备忘录、提醒事项和日历。      |
| `yachiyo-macos-screenshot` | 全屏、窗口和区域截图。                                   |
| `yachiyo-ghostty`          | 查看并驱动 Ghostty 终端会话。                            |
| `yachiyo-pdf`              | PDF 的读取、合并、拆分、旋转、栅格化和填写。             |
| `yachiyo-docx`             | Word 文档 —— 读取、编辑、生成。                          |
| `yachiyo-xlsx`             | 表格与 CSV/TSV —— 清洗、编辑、公式、校验。               |
| `yachiyo-pptx`             | 演示文稿 —— 读取整份、编辑单页，同时保持模板完整。       |
| `yachiyo-zotero`           | 通过 HTTP 服务查询本地 Zotero 库。                       |
| `yachiyo-skill-creator`    | 编写新技能的约定。                                       |

其中几个只支持 macOS，技能本身会在开头说明。

## 排查发现问题

如果一个技能没出现，直接问：

> 我在 `~/.yachiyo/skills/custom/my-skill/` 放了个技能，但你好像没看到。查一下为什么。

它可以列出当前手上有什么、读那个文件、逐条核对常见原因，比你自己查要快。

那些原因，供参考：

1. 文件名不是严格的 `SKILL.md`，或者它直接躺在被扫描的根目录里而不是根目录下的某个子目录里，又或者它嵌在 `node_modules` 内部。
2. frontmatter 解析失败 —— 必须在第一行以 `---` 开始，而且一行里的键和值都不能为空。
3. 某个更早扫描到的根目录里已经有同名技能了。
4. 它被发现了但处于关闭状态。检查 **设置 → 能力 → 技能**。
