import { defineConfig } from 'astro/config'
import react from '@astrojs/react'
import starlight from '@astrojs/starlight'
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
