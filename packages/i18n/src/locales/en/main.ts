export const main = {
  menu: {
    settings: 'Settings...',
    file: 'File',
    edit: 'Edit',
    view: 'View',
    window: 'Window',
    help: 'Help'
  },
  closeGuard: {
    title: 'Active run in progress',
    message: {
      one: 'A run is still active.',
      other: '{count} runs are still active.'
    },
    detail: {
      one: 'Stop the run and close this window?',
      other: 'Stop the active runs and close this window?'
    },
    stopAndClose: 'Stop Run and Close'
  },
  dialogs: {
    selectSessionFile: 'Select session file',
    selectWorkspace: 'Select workspace',
    selectSyncFolder: 'Select sync folder',
    pngImageFilter: 'PNG image'
  },
  cli: {
    installedTitle: 'Yachiyo CLI Installed',
    readySymlinked: 'The yachiyo command is ready. Try it in any terminal!',
    readyRestart: 'Restart your terminal (or run `source ~/.zshrc`) to use the yachiyo command.'
  }
} as const
