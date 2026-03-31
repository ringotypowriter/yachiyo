<div align="center">

# Yachiyo

An open-source alternative to [Alma](http://alma.now/).<br>
No MCP, no plugin marketplace, skills-only.<br>
Only what's necessary for a cyber-assistant that lives in your computer.

</div>

## Why Yachiyo?
Because your AI assistant should be yours — not a platform, not a marketplace, not a maze of configuration files.

Most AI clients want to become ecosystems. They invent protocols, build plugin stores, and lock you into their infrastructure. Yachiyo does the opposite: it gives you a capable assistant that lives in your filesystem, respects your privacy, and gets out of your way.

Skills are just Markdown. Drop a SKILL.md file in your workspace and it works. No runtime. No API surface. No 47-step setup. If you can write a README, you can extend Yachiyo.

No vendor lock-in. Claude today, Gemini tomorrow, your own local model next week. Switch per-message if you want. Your history stays local in SQLite — not in someone else's cloud.

Reply branching. Conversations aren't linear. Branch from any point, explore different paths, navigate the tree. It's how you actually think.

Channels, not silos. One local instance serves Telegram, Discord, and QQ simultaneously with shared context and access control.

No MCP. No telemetry. No plugin marketplace. Just what's necessary for a cyber-assistant that lives in your computer.

---

## Features

- **Multi-provider** — Anthropic, OpenAI, Gemini, Vertex AI, or custom gateway. Switch models per-message.
- **Reply branching** — Messages form a tree. Branch from any turn and navigate alternate replies.
- **Skills, not plugins** — Drop `SKILL.md` files in your workspace. Lazy-loaded, no runtime, no API surface.
- **Channel multiplexing** — Serve Telegram, QQ (OneBot), and Discord from one local instance with access control and token quotas.
- **Group discussion** — Lurk-and-engage state machine for group chats. Speech throttling, autonomous engagement.
- **Coding agent delegation** — Delegate to Claude Code or Codex via the Agent Client Protocol. Post-verification built in.
- **Local-first storage** — SQLite + Drizzle ORM. Everything at `~/.yachiyo/`. No cloud, no telemetry.
- **Built-in memory** — Local FTS5 memory store with automatic recall. External provider supported.
- **Web search & read** — Google (real Chrome session) or Exa. Reader-mode extraction with multi-strategy fallback.
- **Personality layer** — SOUL.md for evolving traits, USER.md for your profile. Layered context assembly.
- **CLI** — `yachiyo provider|agent|soul|config|thread` — fully scriptable, JSON output, keys redacted.

## Getting Started

Download the latest release from the [Releases](https://github.com/ringotypowriter/yachiyo/releases) page. macOS only for now.

## Development

```bash
nvm use
pnpm install
pnpm dev
```

## Contributing

Bug fixes and documentation improvements are welcome.

Feature PRs are **not accepted** unless the feature has been widely discussed and approved through an issue proposal first. Open an issue before writing code.

## Special Thanks

- [Alma](http://alma.now/) — the original inspiration for this project
- [Defuddle](https://github.com/kepano/defuddle) — powers the web reader extraction, such a good tool
- [Cahciua](https://github.com/Menci/Cahciua) — group message structure reference
- [Flowdown](https://flowdown.ai/) — thread emoji icon inspiration

## License

[Apache-2.0](LICENSE)

The Yachiyo name, logo, and branding assets are not covered by this license and remain all rights reserved. See [NOTICE](NOTICE) for details.
