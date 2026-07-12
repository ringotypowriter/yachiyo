import electron from 'electron'
import { onLocaleChange, t } from '@yachiyo/i18n/index'

const { Menu } = electron

export interface ApplicationMenuOptions {
  appName: string
  isDev: boolean
  platform: NodeJS.Platform
  openSettings: () => void
}

function settingsMenuItem(
  platform: NodeJS.Platform,
  openSettings: () => void
): Electron.MenuItemConstructorOptions {
  return {
    label: t('main.menu.settings'),
    accelerator: platform === 'darwin' ? 'Command+,' : 'Ctrl+,',
    click: () => openSettings()
  }
}

function createViewSubmenu(isDev: boolean): Electron.MenuItemConstructorOptions[] {
  if (isDev) {
    return [
      { role: 'reload' },
      { role: 'forceReload' },
      { role: 'toggleDevTools' },
      { type: 'separator' },
      { role: 'resetZoom' },
      { role: 'zoomIn' },
      { role: 'zoomOut' },
      { type: 'separator' },
      { role: 'togglefullscreen' }
    ]
  }

  return [
    { role: 'resetZoom' },
    { role: 'zoomIn' },
    { role: 'zoomOut' },
    { type: 'separator' },
    { role: 'togglefullscreen' }
  ]
}

export function createApplicationMenuTemplate({
  appName,
  isDev,
  platform,
  openSettings
}: ApplicationMenuOptions): Electron.MenuItemConstructorOptions[] {
  const editMenu: Electron.MenuItemConstructorOptions = {
    label: t('main.menu.edit'),
    submenu: [
      { role: 'undo' },
      { role: 'redo' },
      { type: 'separator' },
      { role: 'cut' },
      { role: 'copy' },
      { role: 'paste' },
      { role: 'selectAll' }
    ]
  }
  const viewMenu: Electron.MenuItemConstructorOptions = {
    label: t('main.menu.view'),
    submenu: createViewSubmenu(isDev)
  }
  const helpMenu: Electron.MenuItemConstructorOptions = {
    label: t('main.menu.help'),
    submenu: []
  }

  if (platform === 'darwin') {
    return [
      {
        label: appName,
        submenu: [
          { role: 'about' },
          { type: 'separator' },
          settingsMenuItem(platform, openSettings),
          { type: 'separator' },
          { role: 'services' },
          { type: 'separator' },
          { role: 'hide' },
          { role: 'hideOthers' },
          { role: 'unhide' },
          { type: 'separator' },
          { role: 'quit' }
        ]
      },
      {
        label: t('main.menu.file'),
        submenu: [{ role: 'close' }]
      },
      editMenu,
      viewMenu,
      {
        label: t('main.menu.window'),
        submenu: [{ role: 'minimize' }, { role: 'zoom' }, { type: 'separator' }, { role: 'front' }]
      },
      helpMenu
    ]
  }

  return [
    {
      label: t('main.menu.file'),
      submenu: [settingsMenuItem(platform, openSettings), { type: 'separator' }, { role: 'quit' }]
    },
    editMenu,
    viewMenu,
    {
      label: t('main.menu.window'),
      submenu: [{ role: 'minimize' }, { role: 'close' }]
    },
    helpMenu
  ]
}

export function installApplicationMenu(options: ApplicationMenuOptions): void {
  const rebuild = (): void => {
    Menu.setApplicationMenu(Menu.buildFromTemplate(createApplicationMenuTemplate(options)))
  }
  rebuild()
  onLocaleChange(rebuild)
}
