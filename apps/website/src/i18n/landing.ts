/**
 * Landing page copy, keyed by locale.
 *
 * Only text lives here. Layout data that has nothing to do with language —
 * card positions, drift animations, screenshot sources — stays in the
 * components, matched up by id so the two cannot drift out of order.
 */

export type Locale = 'en' | 'zh'

export const LOCALES: Locale[] = ['en', 'zh']

/** One entry per landing route. `locale: undefined` is the default locale at `/`. */
export interface LandingRoute {
  params: { locale: string | undefined }
  props: { locale: Locale }
}

export function landingRoutes(): LandingRoute[] {
  return LOCALES.map((locale) => ({
    params: { locale: locale === 'en' ? undefined : locale },
    props: { locale }
  }))
}

export type FeatureId =
  | 'branching'
  | 'skills'
  | 'providers'
  | 'channels'
  | 'schedules'
  | 'coding'
  | 'storage'
  | 'research'

export type ValueId = 'yours' | 'no-mcp' | 'no-telemetry' | 'persona'

export type ShotId = 'branching' | 'providers' | 'schedules' | 'essentials'

export interface TitledText {
  title: string
  description: string
}

export interface LandingCopy {
  meta: { title: string; description: string }
  nav: { docs: string; github: string; switchTo: string; switchHref: string }
  hero: {
    badge: string
    tagline: string
    blurb: string
    download: string
    viewSource: string
    license: string
  }
  features: {
    heading: string
    subheading: string
    items: Record<FeatureId, TitledText>
  }
  philosophy: {
    heading: string
    subheading: string
    items: Record<ValueId, TitledText>
  }
  screenshots: {
    heading: string
    subheading: string
    labels: Record<ShotId, { label: string; alt: string }>
  }
  cta: {
    heading: string
    blurb: string
    download: string
    meta: string
    docsLink: string
  }
  footer: {
    docs: string
    releases: string
    rights: string
  }
}

const en: LandingCopy = {
  meta: {
    title: "Yachiyo — only what's necessary for a cyber-assistant that lives in your computer",
    description:
      "Yachiyo — only what's necessary for a cyber-assistant that lives in your computer."
  },
  nav: { docs: 'Docs', github: 'GitHub', switchTo: '中文', switchHref: '/zh/' },
  hero: {
    badge: 'Open source · macOS + Windows · Skills-only',
    tagline: 'your cyber-assistant',
    blurb: "Only what's necessary for a cyber-assistant that lives in your computer.",
    download: 'Download Yachiyo',
    viewSource: 'View on GitHub',
    license: 'Apache-2.0 licensed'
  },
  features: {
    heading: 'What Yachiyo can do',
    subheading: 'The whole feature set fits on a handful of notes. Drag them around.',
    items: {
      branching: {
        title: 'Reply Branching',
        description:
          'Conversations form a tree. Explore different tones without losing the other paths.'
      },
      skills: {
        title: 'Skills are just Markdown',
        description:
          'Drop a SKILL.md into your workspace. No runtime. No API surface. It just works.'
      },
      providers: {
        title: 'Multi-Provider Runtime',
        description: 'Claude today, Gemini tomorrow, your own model next week. Switch per-message.'
      },
      channels: {
        title: 'Channel Multiplexing',
        description:
          'One local instance for Telegram, Discord, and QQ — shared context, shared memory.'
      },
      schedules: {
        title: 'Scheduled Runs',
        description:
          'Set one-off or cron tasks, then let Yachiyo run them while you focus elsewhere.'
      },
      coding: {
        title: 'Coding Agent Dispatch',
        description: 'Hand implementation work to a subagent, then bring the result back in-thread.'
      },
      storage: {
        title: 'Local-First Storage',
        description: 'Everything stays in SQLite under ~/.yachiyo/. No cloud. No telemetry.'
      },
      research: {
        title: 'Browser-Backed Research',
        description: 'Search live sessions, read pages into Markdown, and keep what matters.'
      }
    }
  },
  philosophy: {
    heading: 'Why Yachiyo?',
    subheading: 'Because your assistant should be yours.',
    items: {
      yours: {
        title: 'Yours, not a platform',
        description:
          'Most AI clients want to become ecosystems. Yachiyo respects your privacy and gets out of your way.'
      },
      'no-mcp': {
        title: 'No MCP. No marketplace.',
        description:
          'A skill is one Markdown file you can read, edit, and delete. That is the entire extension surface.'
      },
      'no-telemetry': {
        title: 'No telemetry',
        description:
          'Your data never leaves your machine unless you send it. Local SQLite, local memory, local soul.'
      },
      persona: {
        title: 'A living persona',
        description:
          'SOUL.md and USER.md shape every interaction. She remembers, adapts, and grows alongside you.'
      }
    }
  },
  screenshots: {
    heading: 'See Yachiyo in action',
    subheading: 'A quiet workspace built around threads, runs, and streaming messages.',
    labels: {
      branching: { label: 'Reply Branching', alt: 'Reply branching' },
      providers: { label: 'Providers', alt: 'Provider configuration' },
      schedules: { label: 'Schedules', alt: 'Scheduled runs' },
      essentials: { label: 'Essentials', alt: 'Essentials view' }
    }
  },
  cta: {
    heading: 'Let her into your computer',
    blurb: 'Download the app, add a provider key, and start your first thread in minutes.',
    download: 'Download Yachiyo',
    meta: 'macOS · Windows 11 x64 · Free · Open source · Apache-2.0 · ',
    docsLink: 'Read the docs'
  },
  footer: {
    docs: 'Docs',
    releases: 'Releases',
    rights: 'Name, logo, and branding assets remain all rights reserved.'
  }
}

const zhCN: LandingCopy = {
  meta: {
    title: '八千代 —— 一个住在你电脑里的赛博助手，只保留必要的部分',
    description: '八千代 —— 一个住在你电脑里的赛博助手，只保留必要的部分。'
  },
  nav: { docs: '文档', github: 'GitHub', switchTo: 'English', switchHref: '/' },
  hero: {
    badge: '开源 · macOS + Windows · 只用技能扩展',
    tagline: '你的赛博助手',
    blurb: '一个住在你电脑里的赛博助手，只保留必要的部分。',
    download: '下载八千代',
    viewSource: '在 GitHub 上查看',
    license: 'Apache-2.0 许可'
  },
  features: {
    heading: '八千代能做什么',
    subheading: '全部功能就这么几张便签。可以拖着玩。',
    items: {
      branching: {
        title: '回复分叉',
        description: '对话是一棵树。换个语气再试一次，之前那条路也还在。'
      },
      skills: {
        title: '技能就是 Markdown',
        description: '往工作区丢一个 SKILL.md 就行。没有运行时，没有 API，直接就能用。'
      },
      providers: {
        title: '多供应商运行时',
        description: '今天 Claude，明天 Gemini，下周换成你自己的模型。逐条消息切换。'
      },
      channels: {
        title: '多频道复用',
        description: '一个本地实例同时服务 Telegram、Discord 和 QQ —— 共享上下文，共享记忆。'
      },
      schedules: {
        title: '定时运行',
        description: '设好一次性任务或 cron，让八千代自己去跑，你忙别的。'
      },
      coding: {
        title: '编码任务委派',
        description: '把实现工作交给子智能体，结果再带回这个线程里。'
      },
      storage: {
        title: '本地优先存储',
        description: '一切都在 ~/.yachiyo/ 下的 SQLite 里。没有云，没有遥测。'
      },
      research: {
        title: '带浏览器的调研',
        description: '用真实会话搜索，把网页读成 Markdown，留下有用的部分。'
      }
    }
  },
  philosophy: {
    heading: '为什么是八千代？',
    subheading: '因为你的助手应该属于你。',
    items: {
      yours: {
        title: '是你的，不是一个平台',
        description: '大多数 AI 客户端都想长成生态。八千代尊重你的隐私，然后让开。'
      },
      'no-mcp': {
        title: '没有 MCP，也没有市场',
        description: '一个技能就是一个你能读、能改、能删的 Markdown 文件。扩展面就这么大。'
      },
      'no-telemetry': {
        title: '没有遥测',
        description: '除非你主动发送，数据不会离开你的机器。本地的 SQLite，本地的记忆，本地的灵魂。'
      },
      persona: {
        title: '活着的人格',
        description: 'SOUL.md 和 USER.md 塑造每一次交互。她会记住、会适应，和你一起长。'
      }
    }
  },
  screenshots: {
    heading: '看看它长什么样',
    subheading: '一个安静的工作区，围绕线程、运行和流式消息展开。',
    labels: {
      branching: { label: '回复分叉', alt: '回复分叉' },
      providers: { label: '供应商', alt: '供应商配置' },
      schedules: { label: '定时任务', alt: '定时运行' },
      essentials: { label: '常用入口', alt: '常用入口界面' }
    }
  },
  cta: {
    heading: '把她放进你的电脑',
    blurb: '下载应用，填一个供应商的 key，几分钟就能开始第一个线程。',
    download: '下载八千代',
    meta: 'macOS · Windows 11 x64 · 免费 · 开源 · Apache-2.0 · ',
    docsLink: '阅读文档'
  },
  footer: {
    docs: '文档',
    releases: '版本发布',
    rights: '名称、标识及品牌资产保留所有权利。'
  }
}

const COPY: Record<Locale, LandingCopy> = { en, zh: zhCN }

export function getLandingCopy(locale: Locale): LandingCopy {
  return COPY[locale]
}

/**
 * localStorage key holding an explicitly chosen locale. Its presence disables
 * browser-language detection for good — see the script in Landing.astro. Kept
 * here so the writer (the switcher) and the reader (that script) agree; the
 * script is inlined as a string, so this constant is the only shared source.
 */
export const LANG_KEY = 'yachiyo:lang'

/**
 * Locale-prefixed URLs. Every locale path in the site is built from these two
 * helpers — no component hardcodes a prefix, so moving a locale is a one-line
 * change here rather than a grep across the tree.
 *
 * The default locale is unprefixed, matching Starlight's `root` locale.
 */
export function homeHref(locale: Locale): string {
  return locale === 'en' ? '/' : `/${locale}/`
}

export function docsHref(locale: Locale): string {
  return locale === 'en' ? '/docs/' : `/${locale}/docs/`
}

/** The other locale — drives the language switch and the hreflang alternate. */
export function otherLocale(locale: Locale): Locale {
  return locale === 'en' ? 'zh' : 'en'
}
