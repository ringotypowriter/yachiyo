import log from 'electron-log/main'
import { app, screen, shell, BrowserWindow, globalShortcut, ipcMain } from 'electron'
import type { SettingsConfig, SettingsUpdatedEvent } from '../shared/yachiyo/protocol'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import { installEditableContextMenu } from './editableContextMenu'
import { hydrateProcessEnvFromLoginShell, hydrateProxyFromSystemSettings } from './userShellEnv'
import { resolveYachiyoDataDir } from './yachiyo-server/config/paths'
import { registerYachiyoGateway } from './yachiyoGateway'
import { setupCLI } from './cliSetup'
import { setupCoreSkills } from './coreSkillsSetup'
import { setupAutoUpdate } from './autoUpdate'

// Override console.log/warn/error so all existing log calls persist to file.
// Logs go to ~/Library/Logs/Yachiyo/main.log on macOS.
Object.assign(console, log.functions)
log.errorHandler.startCatching()

const APP_NAME = 'Yachiyo'

app.setName(APP_NAME)

let settingsWindow: BrowserWindow | null = null
let translatorWindow: BrowserWindow | null = null
let jotdownWindow: BrowserWindow | null = null
let mainWindowRef: BrowserWindow | null = null
let isQuitting = false

function maybeDestroyHiddenJotdown(): void {
  if (process.platform === 'darwin') return
  const hasVisible = BrowserWindow.getAllWindows().some((w) => !w.isDestroyed() && w.isVisible())
  if (!hasVisible && jotdownWindow && !jotdownWindow.isDestroyed()) {
    jotdownWindow.destroy()
    jotdownWindow = null
  }
}

function openTranslatorWindow(): void {
  // Always destroy and recreate so tiling WMs (AeroSpace) don't drag
  // the user back to a stale workspace. Destroying + immediately creating
  // a new window in the same tick prevents the main window from stealing focus.
  if (translatorWindow && !translatorWindow.isDestroyed()) {
    translatorWindow.removeAllListeners('close')
    translatorWindow.destroy()
    translatorWindow = null
  }

  const cursorPoint = screen.getCursorScreenPoint()
  const display = screen.getDisplayNearestPoint(cursorPoint)
  const { width: dw, height: dh, x: dx, y: dy } = display.workArea
  const winW = 380
  const winH = 420
  const x = Math.max(dx, Math.min(cursorPoint.x - Math.round(winW / 2), dx + dw - winW))
  const y = Math.max(dy, Math.min(cursorPoint.y - Math.round(winH / 2), dy + dh - winH))

  translatorWindow = new BrowserWindow({
    width: winW,
    height: winH,
    x,
    y,
    resizable: false,
    show: false,
    frame: false,
    alwaysOnTop: true,
    transparent: true,
    ...(process.platform === 'darwin' && {
      vibrancy: 'hud',
      visualEffectState: 'active',
      backgroundColor: '#00000000'
    }),
    icon,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })
  installEditableContextMenu(translatorWindow)
  translatorWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })
  translatorWindow.on('ready-to-show', () => translatorWindow?.show())
  translatorWindow.on('closed', () => {
    translatorWindow = null
    maybeDestroyHiddenJotdown()
  })
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    translatorWindow.loadURL(`${process.env['ELECTRON_RENDERER_URL']}/translator/index.html`)
  } else {
    translatorWindow.loadFile(join(__dirname, '../renderer/translator/index.html'))
  }
}

function openJotdownWindow(): void {
  if (jotdownWindow && !jotdownWindow.isDestroyed()) {
    jotdownWindow.setOpacity(1)
    jotdownWindow.setIgnoreMouseEvents(false)
    jotdownWindow.show()
    jotdownWindow.focus()
    return
  }

  const cursorPoint = screen.getCursorScreenPoint()
  const display = screen.getDisplayNearestPoint(cursorPoint)
  const { width: dw, height: dh, x: dx, y: dy } = display.workArea
  const winW = 480
  const winH = 560
  const x = Math.max(dx, Math.min(cursorPoint.x - Math.round(winW / 2), dx + dw - winW))
  const y = Math.max(dy, Math.min(cursorPoint.y - Math.round(winH / 2), dy + dh - winH))

  jotdownWindow = new BrowserWindow({
    width: winW,
    height: winH,
    minWidth: 360,
    minHeight: 400,
    x,
    y,
    resizable: false,
    show: false,
    frame: false,
    alwaysOnTop: true,
    transparent: true,
    ...(process.platform === 'darwin' && {
      vibrancy: 'hud',
      visualEffectState: 'active',
      backgroundColor: '#00000000'
    }),
    icon,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })
  installEditableContextMenu(jotdownWindow)
  jotdownWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })
  jotdownWindow.on('ready-to-show', () => jotdownWindow?.show())
  jotdownWindow.on('close', (event) => {
    if (!isQuitting) {
      const hasOtherVisible = BrowserWindow.getAllWindows().some(
        (w) => !w.isDestroyed() && w !== jotdownWindow && w.isVisible()
      )
      if (hasOtherVisible) {
        event.preventDefault()
        jotdownWindow?.blur()
        jotdownWindow?.hide()
      }
    }
  })
  jotdownWindow.on('closed', () => {
    jotdownWindow = null
  })
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    jotdownWindow.loadURL(`${process.env['ELECTRON_RENDERER_URL']}/jotdown/index.html`)
  } else {
    jotdownWindow.loadFile(join(__dirname, '../renderer/jotdown/index.html'))
  }
}

app.setPath('userData', resolveYachiyoDataDir())

function createWindow(): void {
  // Create the browser window.
  const mainWindow = new BrowserWindow({
    width: 1100,
    height: 720,
    minWidth: 760,
    minHeight: 500,
    show: false,
    title: APP_NAME,
    autoHideMenuBar: true,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 18 },
    ...(process.platform === 'darwin' && {
      vibrancy: 'under-window',
      visualEffectState: 'active',
      backgroundColor: '#00000000'
    }),
    icon,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })

  mainWindowRef = mainWindow
  mainWindow.on('ready-to-show', () => {
    mainWindow.show()
  })
  mainWindow.on('closed', () => {
    if (mainWindowRef === mainWindow) mainWindowRef = null
    maybeDestroyHiddenJotdown()
  })
  installEditableContextMenu(mainWindow)

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  // HMR for renderer base on electron-vite cli.
  // Load the remote URL for development or the local html file for production.
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.whenReady().then(async () => {
  hydrateProcessEnvFromLoginShell()
  await hydrateProxyFromSystemSettings()
  setupCLI()
  setupCoreSkills()

  // Set app user model id for windows
  electronApp.setAppUserModelId('sh.ringo.yachiyo')

  // Set dock icon for macOS
  if (process.platform === 'darwin' && app.dock) {
    app.dock.setIcon(icon)
  }

  // Default open or close DevTools by F12 in development
  // and ignore CommandOrControl + R in production.
  // see https://github.com/alex8088/electron-toolkit/tree/master/packages/utils
  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  // IPC test
  ipcMain.on('ping', () => console.log('pong'))

  ipcMain.on('set-vibrancy', (event, enabled: boolean) => {
    if (process.platform !== 'darwin') return
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) return
    if (enabled) {
      win.setVibrancy('under-window')
      win.setBackgroundColor('#00000000')
    } else {
      win.setVibrancy(null)
      win.setBackgroundColor('#f5f4f0')
    }
  })
  const server = registerYachiyoGateway()

  function updateFloatWindowShortcuts(config: SettingsConfig): void {
    globalShortcut.unregisterAll()
    const translatorShortcut = config.general?.translatorShortcut?.trim()
    const jotdownShortcut = config.general?.jotdownShortcut?.trim()
    if (translatorShortcut) {
      if (!globalShortcut.register(translatorShortcut, () => openTranslatorWindow())) {
        globalShortcut.register('CommandOrControl+Shift+T', () => openTranslatorWindow())
      }
    }
    if (jotdownShortcut) {
      if (!globalShortcut.register(jotdownShortcut, () => openJotdownWindow())) {
        globalShortcut.register('CommandOrControl+Shift+J', () => openJotdownWindow())
      }
    }
  }

  void server.getConfig().then((initialConfig) => {
    updateFloatWindowShortcuts(initialConfig)
  })

  server.subscribe((event) => {
    if (event.type === 'settings.updated') {
      updateFloatWindowShortcuts((event as SettingsUpdatedEvent).config)
    }
  })

  ipcMain.on('navigate-to-archived-thread', (_event, threadId: string) => {
    // Forward to the main window, then close settings.
    for (const win of BrowserWindow.getAllWindows()) {
      if (win !== settingsWindow && !win.isDestroyed()) {
        win.webContents.send('navigate-to-archived-thread', threadId)
        win.focus()
      }
    }
    if (settingsWindow && !settingsWindow.isDestroyed()) {
      settingsWindow.close()
    }
  })

  ipcMain.on('open-translator', () => openTranslatorWindow())
  ipcMain.on('open-jotdown', () => openJotdownWindow())

  ipcMain.on('hide-translator', () => {
    if (translatorWindow && !translatorWindow.isDestroyed()) {
      translatorWindow.setOpacity(0)
      translatorWindow.setIgnoreMouseEvents(true)
    }
  })
  ipcMain.on('hide-jotdown', () => {
    if (jotdownWindow && !jotdownWindow.isDestroyed()) {
      jotdownWindow.setOpacity(0)
      jotdownWindow.setIgnoreMouseEvents(true)
    }
  })

  ipcMain.on('pause-global-shortcuts', () => {
    globalShortcut.unregisterAll()
  })

  ipcMain.on('resume-global-shortcuts', () => {
    void server.getConfig().then((config) => {
      updateFloatWindowShortcuts(config)
    })
  })

  ipcMain.on('open-settings', (_event, tab?: string) => {
    if (settingsWindow && !settingsWindow.isDestroyed()) {
      settingsWindow.focus()
      if (tab) {
        settingsWindow.webContents.send('navigate-settings-to', tab)
      }
      return
    }
    settingsWindow = new BrowserWindow({
      width: 1000,
      height: 660,
      resizable: false,
      minimizable: false,
      show: false,
      frame: false,
      backgroundColor: '#eaf2f7',
      icon,
      webPreferences: {
        preload: join(__dirname, '../preload/index.js'),
        sandbox: false
      }
    })
    installEditableContextMenu(settingsWindow)
    settingsWindow.webContents.setWindowOpenHandler((details) => {
      shell.openExternal(details.url)
      return { action: 'deny' }
    })
    settingsWindow.on('ready-to-show', () => settingsWindow?.show())
    settingsWindow.on('closed', () => {
      settingsWindow = null
      maybeDestroyHiddenJotdown()
    })
    const hash = tab ? `#${tab}` : ''
    if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
      settingsWindow.loadURL(`${process.env['ELECTRON_RENDERER_URL']}/settings/index.html${hash}`)
    } else {
      settingsWindow.loadFile(join(__dirname, '../renderer/settings/index.html'), {
        hash: tab
      })
    }
  })

  createWindow()
  setupAutoUpdate()

  app.on('activate', function () {
    // Dock click should always go straight to the main window, not to whatever
    // auxiliary window (jotdown/translator) happens to be hidden in another
    // workspace. If the main window is gone, recreate it.
    if (mainWindowRef && !mainWindowRef.isDestroyed()) {
      if (mainWindowRef.isMinimized()) mainWindowRef.restore()
      mainWindowRef.show()
      mainWindowRef.focus()
      return
    }
    createWindow()
  })
})

// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// explicitly with Cmd + Q.
app.on('before-quit', () => {
  isQuitting = true
})

app.on('will-quit', () => {
  globalShortcut.unregisterAll()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

// In this file you can include the rest of your app's specific main process
// code. You can also put them in separate files and require them here.
