import { app, shell, BrowserWindow, ipcMain } from 'electron'
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

const APP_NAME = 'Yachiyo'

app.setName(APP_NAME)

let settingsWindow: BrowserWindow | null = null

app.setPath('userData', resolveYachiyoDataDir())

function createWindow(): void {
  // Create the browser window.
  const mainWindow = new BrowserWindow({
    width: 1100,
    height: 720,
    minWidth: 760,
    minHeight: 500,
    show: false,
    autoHideMenuBar: true,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 18 },
    ...(process.platform === 'darwin' && {
      vibrancy: 'under-window',
      backgroundColor: '#00000000'
    }),
    icon,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow.show()
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
app.whenReady().then(() => {
  hydrateProcessEnvFromLoginShell()
  hydrateProxyFromSystemSettings()
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
  registerYachiyoGateway()

  ipcMain.on('open-settings', () => {
    if (settingsWindow && !settingsWindow.isDestroyed()) {
      settingsWindow.focus()
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
    })
    if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
      settingsWindow.loadURL(`${process.env['ELECTRON_RENDERER_URL']}/settings/index.html`)
    } else {
      settingsWindow.loadFile(join(__dirname, '../renderer/settings/index.html'))
    }
  })

  createWindow()
  setupAutoUpdate()

  app.on('activate', function () {
    // On macOS it's common to re-create a window in the app when the
    // dock icon is clicked and there are no other windows open.
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// explicitly with Cmd + Q.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

// In this file you can include the rest of your app's specific main process
// code. You can also put them in separate files and require them here.
