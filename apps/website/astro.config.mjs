import { defineConfig } from 'astro/config'
import react from '@astrojs/react'
import starlight from '@astrojs/starlight'
import starlightLlmsTxt from 'starlight-llms-txt'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  integrations: [
    react(),
    starlight({
      title: 'Yachiyo',
      description:
        'Documentation for Yachiyo — a local-first cyber-assistant that lives in your computer.',
      logo: { src: './src/assets/icon.png', alt: 'Yachiyo' },
      favicon: '/icon.png',
      customCss: ['./src/styles/docs.css'],
      plugins: [
        // Emits /llms.txt, /llms-full.txt, /llms-small.txt and the customSets
        // below. Pinned to 0.10.x: 0.11+ needs astro@^7 and starlight >=0.41,
        // the same wall that keeps Starlight itself on 0.40.
        //
        // English only, and that is the plugin's own behaviour rather than a
        // choice made here — it filters the collection through `isDefaultLocale`,
        // so `zh/**` entries never reach the generator and no `paths` glob can
        // pull them back in.
        starlightLlmsTxt({
          projectName: 'Yachiyo',
          description:
            'A local-first desktop AI assistant for macOS. Runs on your machine, stores everything under ~/.yachiyo, and talks to whichever model provider you configure. Skills are plain Markdown files — there is no MCP layer and no plugin marketplace.',
          details: [
            '- Extension model: a skill is a directory containing a `SKILL.md`. No runtime, manifest, or registration step.',
            '- Configuration lives in two TOML files under `~/.yachiyo`; the desktop app and the `yachiyo` CLI both read and write them.',
            '- The assistant administers itself: it ships with the `yachiyo-help` skill enabled and has shell access, so setup tasks are asked for in plain language rather than performed by hand.'
          ].join('\n'),
          // Entry points first, exhaustive key-by-key references last.
          promote: ['docs', 'docs/install', 'docs/quickstart', 'docs/concepts'],
          demote: ['docs/reference/config-toml', 'docs/reference/channels-toml'],
          customSets: [
            {
              label: 'CLI reference',
              description: 'every `yachiyo` command namespace, its flags, and its payload shapes',
              paths: ['docs/cli/**']
            },
            {
              label: 'Guides',
              description:
                'task-oriented guides for providers, skills, workspaces, channels, and schedules',
              paths: ['docs/guides/**']
            }
          ]
        })
      ],
      defaultLocale: 'root',
      locales: {
        root: { label: 'English', lang: 'en' },
        zh: { label: '简体中文', lang: 'zh-CN' }
      },
      social: [
        { icon: 'github', label: 'GitHub', href: 'https://github.com/ringotypowriter/yachiyo' }
      ],
      editLink: {
        baseUrl: 'https://github.com/ringotypowriter/yachiyo/edit/main/apps/website/'
      },
      lastUpdated: true,
      head: [
        { tag: 'link', attrs: { rel: 'preconnect', href: 'https://fonts.googleapis.com' } },
        {
          tag: 'link',
          attrs: { rel: 'preconnect', href: 'https://fonts.gstatic.com', crossorigin: 'anonymous' }
        },
        {
          tag: 'link',
          attrs: {
            rel: 'stylesheet',
            href: 'https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&display=swap'
          }
        }
      ],
      sidebar: [
        {
          label: 'Start here',
          translations: { 'zh-CN': '从这里开始' },
          items: [
            { slug: 'docs' },
            { slug: 'docs/install' },
            { slug: 'docs/quickstart' },
            { slug: 'docs/concepts' }
          ]
        },
        {
          label: 'Guides',
          translations: { 'zh-CN': '指南' },
          items: [
            { slug: 'docs/guides/providers' },
            { slug: 'docs/guides/skills' },
            { slug: 'docs/guides/workspace' },
            { slug: 'docs/guides/memory-and-persona' },
            { slug: 'docs/guides/coding-agents' },
            { slug: 'docs/guides/schedules' },
            { slug: 'docs/guides/channels' },
            { slug: 'docs/guides/web-search' },
            { slug: 'docs/guides/sync' }
          ]
        },
        {
          label: 'CLI',
          translations: { 'zh-CN': '命令行' },
          items: [
            { slug: 'docs/cli' },
            { slug: 'docs/cli/provider' },
            { slug: 'docs/cli/agent' },
            { slug: 'docs/cli/config' },
            { slug: 'docs/cli/thread' },
            { slug: 'docs/cli/schedule' },
            { slug: 'docs/cli/channel' },
            { slug: 'docs/cli/send' },
            { slug: 'docs/cli/soul' }
          ]
        },
        {
          label: 'Reference',
          translations: { 'zh-CN': '参考' },
          items: [
            { slug: 'docs/reference/config-toml' },
            { slug: 'docs/reference/channels-toml' },
            { slug: 'docs/reference/paths' },
            { slug: 'docs/reference/faq' }
          ]
        },
        {
          label: 'Elsewhere',
          translations: { 'zh-CN': '其他' },
          // No "back to the site" entry here — Starlight's site title already
          // links home, and it resolves per-locale (`/` vs `/zh/`) whereas a
          // sidebar link would be stuck on one language.
          items: [
            {
              label: 'Releases',
              translations: { 'zh-CN': '版本发布' },
              link: 'https://github.com/ringotypowriter/yachiyo/releases'
            }
          ]
        }
      ]
    })
  ],
  vite: {
    plugins: [
      tailwindcss(),
      {
        // Astro's dev server sends no `cache-control`, so browsers fall back to
        // heuristic caching and can pin a page for a long time. That bit hard
        // once: a temporary redirect at `/zh-cn/` stayed cached in the browser
        // long after the redirect was deleted, and no amount of restarting the
        // dev server could dislodge it. Never cache dev responses.
        name: 'yachiyo:dev-no-store',
        apply: 'serve',
        configureServer(server) {
          server.middlewares.use((_req, res, next) => {
            res.setHeader('Cache-Control', 'no-store, must-revalidate')
            next()
          })
        }
      }
    ]
  },
  outDir: './dist',
  site: 'https://yachiyo.ringo.sh'
})
