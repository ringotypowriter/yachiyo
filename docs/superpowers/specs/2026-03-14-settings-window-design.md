# Settings Window — Design Spec

**Date:** 2026-03-14
**Status:** Approved
**Scope:** Frontend prototype only — tab shell with empty content placeholders

---

## 1. Overview

A second Electron BrowserWindow that opens when the user clicks the Settings button in the main sidebar. Implemented as a separate renderer entry point using electron-vite multi-input config. Settings read/write will connect to the backend server in a future milestone; this spec covers only the frontend shell.

---

## 2. Window Properties

| Property | Value |
|---|---|
| Width | 820px |
| Height | 580px |
| `titleBarStyle` | `hiddenInset` |
| `trafficLightPosition` | `{ x: 16, y: 18 }` |
| `resizable` | `false` |
| `minimizable` | `false` |
| `frame` | default (macOS native) |
| Background color | `#f0efeb` |
| `webPreferences.preload` | `join(__dirname, '../preload/index.js')` |
| `webPreferences.sandbox` | `false` |

The window is opened exactly once per click — if already open, focus it instead of creating a duplicate.

> **Note:** macOS only for this milestone. Non-macOS behavior is not in scope.

---

## 3. How It Opens

**Main window (renderer):** The Settings button (`<Settings>` icon in sidebar footer) calls:
```ts
ipcRenderer.send('open-settings')
```

**Preload (`src/preload/index.ts`):** Exposes `openSettings()` via `contextBridge`.

**Main process (`src/main/index.ts`):** `settingsWindow` is declared at **module scope** (outside `app.whenReady()`). `ipcMain.on` is registered inside `app.whenReady()`.

```ts
// module scope
let settingsWindow: BrowserWindow | null = null

// inside app.whenReady():
ipcMain.on('open-settings', () => {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.focus()
    return
  }
  settingsWindow = new BrowserWindow({
    width: 820, height: 580,
    resizable: false, minimizable: false,
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
  settingsWindow.on('closed', () => { settingsWindow = null })

  // Dev: Vite serves settings entry at /settings/index.html
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    settingsWindow.loadURL(`${process.env['ELECTRON_RENDERER_URL']}/settings/index.html`)
  } else {
    settingsWindow.loadFile(join(__dirname, '../renderer/settings/index.html'))
  }
})
```

---

## 4. Renderer Entry Points

### New: `src/renderer/settings/`

```
src/renderer/settings/
  index.html     ← <script type="module" src="./main.tsx"></script>
  main.tsx       ← React root
  App.tsx        ← SettingsApp shell
```

### electron-vite config change

Add a second `input` to the renderer config in `electron.vite.config.ts`:
```ts
renderer: {
  input: {
    main: resolve('src/renderer/index.html'),
    settings: resolve('src/renderer/settings/index.html'),
  },
  plugins: [react(), tailwindcss()],
}
```

---

## 5. UI Layout

```
┌─ BrowserWindow (820×580) ──────────────────────────────────┐
│  ● ● ●   [titlebar / drag region, 52px]                    │
├────────────────────────────────────────────────────────────┤
│  Sidebar (210px)  │  Content area (flex-1)                 │
│  ─────────────    │  ─────────────────────                 │
│  Settings         │  [Header: icon + tab title]            │
│                   │                                        │
│  ○ General  ←active  [Body: empty placeholder]             │
│  ○ Providers  │                                            │
│  ○ Chat       │                                            │
│  ○ Memory     │                                            │
│  ○ User Interface                                          │
│  ○ About      │                                            │
│               │  ─────────────────────                     │
│               │  [Footer: status | Close  Save]            │
└────────────────────────────────────────────────────────────┘
```

### 5.1 Sidebar

- Width: 210px, background: `#e8e6e1`
- "Settings" heading: `font-size: 18px, font-weight: 700`
- Nav items: 6 entries with lucide-react icons (16px, `strokeWidth={1.5}`)
- Active item: white pill background with subtle shadow
- No footer buttons (Import/Export/Reset deferred)

**Nav tabs and icons:**

| Tab | Lucide icon |
|---|---|
| General | `Settings2` |
| Providers | `Cpu` |
| Chat | `MessageSquare` |
| Memory | `Brain` |
| User Interface | `Monitor` |
| About | `Info` |

### 5.2 Content Area

- Background: `#f5f4f0`
- **Header** (border-bottom): icon + tab name, 20px bold
- **Body**: empty placeholder — centered dashed circle + "Content coming soon" text at 40% opacity
- **Footer** (border-top):
  - Left: "All changes saved" in `#8e8e93`
  - Right: `Close` button (closes window) + `Save` button (disabled/greyed — no dirty state yet)

---

## 6. State

Single `useState<TabId>` in `SettingsApp` for the active tab. No settings store needed for this milestone. `isDirty` is always `false` for now (Save remains disabled).

```ts
type TabId = 'general' | 'providers' | 'chat' | 'memory' | 'ui' | 'about'
```

---

## 7. Files Changed / Created

| File | Action |
|---|---|
| `electron.vite.config.ts` | Add second renderer input |
| `src/main/index.ts` | Add `settingsWindow` ref + `ipcMain.on('open-settings', ...)` handler |
| `src/preload/index.ts` | Expose `openSettings` via contextBridge |
| `src/preload/index.d.ts` | Add `openSettings: () => void` to `window.api` type |
| `src/renderer/settings/index.html` | New |
| `src/renderer/settings/main.tsx` | New |
| `src/renderer/settings/App.tsx` | New — full settings shell |
| `src/renderer/src/App.tsx` | Wire Settings button to `window.api.openSettings()` |

---

## 8. Out of Scope (This Milestone)

- Actual settings content for any tab
- Settings persistence / backend API calls
- Import / Export / Reset Settings buttons
- Keyboard shortcut to open settings (⌘,)
