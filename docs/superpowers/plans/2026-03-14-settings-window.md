# Settings Window Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a separate macOS Settings window (820×580) with 6 navigation tabs and empty placeholder content, opened from the main sidebar's Settings button via Electron IPC.

**Architecture:** A second electron-vite renderer entry (`src/renderer/settings/`) produces its own `settings.html`. The main process listens to an `open-settings` IPC event and manages a single `BrowserWindow` reference (focus if already open, create if not). The preload exposes `window.api.openSettings()` to both renderers.

**Tech Stack:** Electron IPC, electron-vite multi-input renderer, React 18, Tailwind CSS v4, lucide-react

---

## File Map

| File | Action | Responsibility |
|---|---|---|
| `electron.vite.config.ts` | Modify | Add `build.rollupOptions.input` with two entries |
| `src/preload/index.ts` | Modify | Add `openSettings` to the `api` object |
| `src/preload/index.d.ts` | Modify | Type `window.api` as `{ openSettings: () => void }` |
| `src/main/index.ts` | Modify | Add module-scope `settingsWindow` ref + `ipcMain.on('open-settings')` |
| `src/renderer/settings/index.html` | Create | HTML entry point for settings renderer |
| `src/renderer/settings/styles.css` | Create | Tailwind import + base reset + drag-region classes |
| `src/renderer/settings/main.tsx` | Create | React DOM root for settings |
| `src/renderer/settings/App.tsx` | Create | Full settings shell: sidebar nav + content area + footer |
| `src/renderer/src/App.tsx` | Modify | Wire Settings button `onClick` to `window.api.openSettings()` |

---

## Chunk 1: Build Config + IPC Layer

### Task 1: electron-vite multi-input config

**Files:**
- Modify: `electron.vite.config.ts`

- [ ] **Step 1: Add multi-input to renderer config**

Replace the renderer block in `electron.vite.config.ts`:

```ts
import { resolve } from 'path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  main: {},
  preload: {},
  renderer: {
    build: {
      rollupOptions: {
        input: {
          main: resolve('src/renderer/index.html'),
          settings: resolve('src/renderer/settings/index.html'),
        },
      },
    },
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src'),
      },
    },
    plugins: [react(), tailwindcss()],
  },
})
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
pnpm typecheck
```

Expected: zero errors (settings/index.html doesn't exist yet so this is just checking TS, not the build).

---

### Task 2: Preload — expose openSettings

**Files:**
- Modify: `src/preload/index.ts`
- Modify: `src/preload/index.d.ts`

- [ ] **Step 1: Add `ipcRenderer` import and `openSettings` to api**

Full replacement of `src/preload/index.ts`:

```ts
import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'

const api = {
  openSettings: () => ipcRenderer.send('open-settings'),
}

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore (define in dts)
  window.electron = electronAPI
  // @ts-ignore (define in dts)
  window.api = api
}
```

- [ ] **Step 2: Type `window.api` in the declaration file**

Full replacement of `src/preload/index.d.ts`:

```ts
import { ElectronAPI } from '@electron-toolkit/preload'

declare global {
  interface Window {
    electron: ElectronAPI
    api: {
      openSettings: () => void
    }
  }
}
```

- [ ] **Step 3: Verify TypeScript compiles**

```bash
pnpm typecheck
```

Expected: zero errors.

- [ ] **Step 4: Commit**

```bash
git add electron.vite.config.ts src/preload/index.ts src/preload/index.d.ts
git commit -m "feat: add multi-input vite config and expose openSettings IPC"
```

---

### Task 3: Main process — settings window handler

**Files:**
- Modify: `src/main/index.ts`

- [ ] **Step 1: Add module-scope `settingsWindow` ref**

After the imports in `src/main/index.ts`, add at module scope (before `createWindow`):

```ts
let settingsWindow: BrowserWindow | null = null
```

- [ ] **Step 2: Register IPC handler inside `app.whenReady()`**

Inside `app.whenReady().then(...)`, after the existing `ipcMain.on('ping', ...)` line, add:

```ts
ipcMain.on('open-settings', () => {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.focus()
    return
  }
  settingsWindow = new BrowserWindow({
    width: 820,
    height: 580,
    resizable: false,
    minimizable: false,
    show: false,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 18 },
    backgroundColor: '#f0efeb',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
    },
  })
  settingsWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })
  settingsWindow.on('ready-to-show', () => settingsWindow?.show())
  settingsWindow.on('closed', () => {
    settingsWindow = null
  })
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    settingsWindow.loadURL(
      `${process.env['ELECTRON_RENDERER_URL']}/settings/index.html`,
    )
  } else {
    settingsWindow.loadFile(join(__dirname, '../renderer/settings/index.html'))
  }
})
```

- [ ] **Step 3: Verify TypeScript compiles**

```bash
pnpm typecheck
```

Expected: zero errors. `BrowserWindow`, `ipcMain`, `shell`, `join`, `is` are all already imported in this file.

- [ ] **Step 4: Commit**

```bash
git add src/main/index.ts
git commit -m "feat: add settings BrowserWindow IPC handler"
```

---

## Chunk 2: Settings Renderer + Button Wiring

### Task 4: Settings renderer files

**Files:**
- Create: `src/renderer/settings/index.html`
- Create: `src/renderer/settings/styles.css`
- Create: `src/renderer/settings/main.tsx`
- Create: `src/renderer/settings/App.tsx`

- [ ] **Step 1: Create `src/renderer/settings/index.html`**

```html
<!doctype html>
<html>
  <head>
    <meta charset="UTF-8" />
    <title>Yachiyo — Settings</title>
    <meta
      http-equiv="Content-Security-Policy"
      content="default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:"
    />
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="./main.tsx"></script>
  </body>
</html>
```

- [ ] **Step 2: Create `src/renderer/settings/styles.css`**

```css
@import "tailwindcss";

*, *::before, *::after {
  box-sizing: border-box;
}

html, body, #root {
  height: 100%;
  margin: 0;
  padding: 0;
  overflow: hidden;
}

body {
  font-family: -apple-system, BlinkMacSystemFont, 'Helvetica Neue', Arial, sans-serif;
  background: #f0efeb;
  color: #1c1c1e;
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
}

.drag-region {
  -webkit-app-region: drag;
}

.no-drag {
  -webkit-app-region: no-drag;
}
```

- [ ] **Step 3: Create `src/renderer/settings/main.tsx`**

```tsx
import './styles.css'
import React from 'react'
import ReactDOM from 'react-dom/client'
import SettingsApp from './App'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <SettingsApp />
  </React.StrictMode>,
)
```

- [ ] **Step 4: Create `src/renderer/settings/App.tsx`**

```tsx
import { useState } from 'react'
import { Settings2, Cpu, MessageSquare, Brain, Monitor, Info } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'

type TabId = 'general' | 'providers' | 'chat' | 'memory' | 'ui' | 'about'

interface Tab {
  id: TabId
  label: string
  icon: LucideIcon
}

const TABS: Tab[] = [
  { id: 'general',   label: 'General',        icon: Settings2     },
  { id: 'providers', label: 'Providers',       icon: Cpu           },
  { id: 'chat',      label: 'Chat',            icon: MessageSquare },
  { id: 'memory',    label: 'Memory',          icon: Brain         },
  { id: 'ui',        label: 'User Interface',  icon: Monitor       },
  { id: 'about',     label: 'About',           icon: Info          },
]

function SettingsApp() {
  const [activeTab, setActiveTab] = useState<TabId>('general')

  const active = TABS.find((t) => t.id === activeTab)!
  const ActiveIcon = active.icon

  return (
    <div className="flex h-full overflow-hidden">
      {/* ── Sidebar ─────────────────────────────────── */}
      <div
        className="flex flex-col shrink-0"
        style={{ width: '210px', background: '#e8e6e1', borderRight: '1px solid rgba(0,0,0,0.08)' }}
      >
        {/* Traffic-lights zone + title */}
        <div
          className="drag-region shrink-0 flex items-end pb-2"
          style={{ height: '52px', paddingLeft: '16px' }}
        >
          <span className="font-bold text-lg" style={{ color: '#1c1c1e', letterSpacing: '-0.3px' }}>
            Settings
          </span>
        </div>

        {/* Nav */}
        <nav className="flex-1 px-2 py-1 overflow-y-auto no-drag">
          {TABS.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              onClick={() => setActiveTab(id)}
              className="w-full flex items-center gap-2.5 px-2.5 py-1.5 rounded-lg text-sm text-left mb-0.5 transition-all"
              style={
                activeTab === id
                  ? {
                      background: 'rgba(255,255,255,0.75)',
                      color: '#1c1c1e',
                      fontWeight: 500,
                      boxShadow: '0 1px 3px rgba(0,0,0,0.08)',
                    }
                  : { color: '#3a3a3c' }
              }
            >
              <Icon
                size={16}
                strokeWidth={1.5}
                style={{ opacity: activeTab === id ? 1 : 0.65, flexShrink: 0 }}
              />
              {label}
            </button>
          ))}
        </nav>
      </div>

      {/* ── Content area ────────────────────────────── */}
      <div className="flex flex-col flex-1 min-w-0" style={{ background: '#f5f4f0' }}>
        {/* Header */}
        <div
          className="shrink-0 flex items-center gap-2.5 drag-region"
          style={{ height: '52px', padding: '0 28px', borderBottom: '1px solid rgba(0,0,0,0.07)' }}
        >
          <ActiveIcon size={20} strokeWidth={1.5} style={{ color: '#1c1c1e', opacity: 0.75 }} />
          <span
            className="font-semibold text-xl"
            style={{ color: '#1c1c1e', letterSpacing: '-0.3px' }}
          >
            {active.label}
          </span>
        </div>

        {/* Body — empty placeholder */}
        <div className="flex-1 overflow-y-auto flex items-center justify-center">
          <div className="flex flex-col items-center gap-2.5" style={{ opacity: 0.4 }}>
            <div
              className="flex items-center justify-center rounded-full"
              style={{ width: 40, height: 40, border: '2px dashed #8e8e93' }}
            >
              <svg
                width="16"
                height="16"
                viewBox="0 0 16 16"
                fill="none"
                stroke="#8e8e93"
                strokeWidth="1.5"
              >
                <path d="M8 4v8M4 8h8" />
              </svg>
            </div>
            <span className="text-sm" style={{ color: '#8e8e93' }}>
              Content coming soon
            </span>
          </div>
        </div>

        {/* Footer */}
        <div
          className="shrink-0 no-drag flex items-center justify-between px-5 py-3"
          style={{ borderTop: '1px solid rgba(0,0,0,0.08)' }}
        >
          <span className="text-xs" style={{ color: '#8e8e93' }}>
            All changes saved
          </span>
          <div className="flex items-center gap-2">
            <button
              onClick={() => window.close()}
              className="px-4 py-1.5 rounded-lg text-sm font-medium"
              style={{
                background: 'rgba(255,255,255,0.8)',
                border: '1px solid rgba(0,0,0,0.15)',
                color: '#1c1c1e',
                cursor: 'pointer',
              }}
            >
              Close
            </button>
            <button
              disabled
              className="px-4 py-1.5 rounded-lg text-sm font-medium"
              style={{
                background: '#8e8e93',
                color: '#fff',
                opacity: 0.4,
                border: '1px solid transparent',
                cursor: 'not-allowed',
              }}
            >
              Save
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

export default SettingsApp
```

- [ ] **Step 5: Verify TypeScript compiles**

```bash
pnpm typecheck
```

Expected: zero errors.

- [ ] **Step 6: Commit**

```bash
git add src/renderer/settings/
git commit -m "feat: add settings renderer entry — shell with 6 tabs and empty content"
```

---

### Task 5: Wire Settings button in main App

**Files:**
- Modify: `src/renderer/src/App.tsx`

- [ ] **Step 1: Add `onClick` to the Settings button**

In `src/renderer/src/App.tsx`, find the Settings button in the `Sidebar` component (currently has no `onClick`). Add the handler:

```tsx
<button
  onClick={() => window.api.openSettings()}
  className="p-1.5 rounded-md opacity-40 hover:opacity-70 transition-opacity"
  style={{ color: '#1c1c1e' }}
>
  <Settings size={16} strokeWidth={1.5} />
</button>
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
pnpm typecheck
```

Expected: zero errors. `window.api.openSettings` is now typed via `src/preload/index.d.ts`.

- [ ] **Step 3: Commit**

```bash
git add src/renderer/src/App.tsx
git commit -m "feat: wire Settings button to open settings window"
```

---

## Final Verification

- [ ] **Run the app**

```bash
pnpm dev
```

- [ ] **Manual test checklist**
  - Click the Settings gear icon in the sidebar → settings window opens
  - Click the gear icon again while settings is open → settings window focuses (doesn't open a second one)
  - Click through all 6 tabs (General, Providers, Chat, Memory, User Interface, About) → header title + icon update, body shows placeholder
  - Click Close → window closes
  - Save button is visually greyed out and not clickable
  - Window is not resizable (drag corner → nothing happens)
  - Titlebar shows traffic lights, is draggable
