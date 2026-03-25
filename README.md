# Yachiyo

A desktop AI chat application designed for thoughtful, long-form conversations. Yachiyo puts you in control with a clean, distraction-free interface and the flexibility to work with multiple AI providers.

![Version](https://img.shields.io/badge/version-1.0.0-blue)
![Electron](https://img.shields.io/badge/Electron-39.x-47848F?logo=electron)
![React](https://img.shields.io/badge/React-19.x-61DAFB?logo=react)
![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178C6?logo=typescript)

## What is Yachiyo?

Yachiyo is a **chat-first, agent-ready** AI client that prioritizes:

- **Multi-thread conversations** — Organize your thoughts across separate discussion threads
- **Streamed responses** — Watch AI replies flow in real-time
- **Local-first storage** — Your conversation history lives in a local SQLite database
- **Provider flexibility** — Connect to OpenAI, Anthropic, Google, and other AI services
- **Clean, focused UI** — No clutter, just you and your conversations

> Yachiyo (八千代) is a Japanese name evoking longevity and clarity — qualities we strive to bring to every conversation.

## Features

- 💬 **Rich Chat Interface** — Markdown rendering, code highlighting, and smooth scrolling
- 🔀 **Thread Management** — Create, organize, and switch between conversation threads
- 🧠 **Memory & Context** — Smart context management with append-only conversation history
- 🔌 **Extensible Skills** — Plugin system for extending capabilities
- ⚙️ **Flexible Configuration** — Customizable prompts, providers, and UI preferences
- 🖥️ **Native Desktop Experience** — Built with Electron for macOS (Windows & Linux coming soon)

## Installation

### Prerequisites

- **Node.js** 22.22.1 (use `nvm use` to switch to the pinned version)
- **pnpm** 10.x (`npm install -g pnpm`)

### Setup

```bash
# Clone the repository
git clone https://github.com/ringotypowriter/yachiyo.git
cd yachiyo

# Use the correct Node version
nvm use

# Install dependencies
pnpm install

# Rebuild native dependencies for Electron
pnpm run native:rebuild
```

### Running the App

```bash
# Development mode with hot reload
pnpm dev

# Preview the production build
pnpm start
```

## Building

Create platform-specific installers:

```bash
# macOS (currently the only supported platform)
pnpm run build:mac
```

## Usage

1. **First Launch**: Open Yachiyo and configure your AI provider API keys in Settings
2. **Start a Thread**: Press `⌘/Ctrl + T` to create a new conversation thread
3. **Chat**: Type your message and press Enter to send
4. **Navigate**: Use the sidebar to switch between threads or search your history
5. **Customize**: Open Settings (`⌘/Ctrl + ,`) to adjust providers, prompts, and UI preferences

### Keyboard Shortcuts

| Shortcut             | Action                 |
| -------------------- | ---------------------- |
| `⌘/Ctrl + T`         | Create new thread      |
| `⌘/Ctrl + F`         | Search threads         |
| `⌘/Ctrl + ,`         | Open settings          |
| `⌘/Ctrl + Shift + F` | Find in current thread |

## Development

### Project Structure

```
Yachiyo
├── src/
│   ├── main/              # Electron main process
│   │   └── yachiyo-server/ # Local backend server
│   ├── preload/           # Electron preload scripts
│   ├── renderer/          # React UI
│   │   ├── src/           # Main chat interface
│   │   └── settings/      # Settings window
│   └── shared/            # Shared types and utilities
├── docs/                  # Architecture and design docs
├── build/                 # Build resources
└── resources/             # Static assets
```

### Testing

```bash
# Run server tests (in-memory storage)
pnpm run test:server

# Run native SQLite tests (requires Electron)
pnpm run test:server:native
```

### Code Quality

```bash
# Lint
pnpm run lint

# Type check
pnpm run typecheck

# Format
pnpm run format
```

### Database Migrations

```bash
# Generate migrations after schema changes
pnpm run db:generate

# Apply migrations
pnpm run db:migrate

# Open Drizzle Studio
pnpm run db:studio
```

## Configuration

Yachiyo stores its configuration and data in:

- **macOS**: `~/.yachiyo/`

Set the `YACHIYO_HOME` environment variable to use a custom location.

## Tech Stack

- **Desktop Shell**: Electron 39
- **Frontend**: React 19 + TypeScript 5
- **Styling**: Tailwind CSS 4
- **State Management**: Zustand
- **Data Fetching**: TanStack Query
- **Database**: SQLite with Drizzle ORM
- **AI SDK**: Vercel AI SDK

## Contributing

Contributions are welcome! Please:

1. Follow the existing code style (2-space indentation, single quotes, no semicolons)
2. Add tests for new features
3. Run `pnpm run lint` and `pnpm run typecheck` before submitting
4. Use [Conventional Commits](https://www.conventionalcommits.org/) for commit messages

## License

MIT © Ringo

---

Made with 💙 for better AI conversations.
