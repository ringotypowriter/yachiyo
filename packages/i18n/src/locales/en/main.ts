export const main = {
  startupFailure: {
    title: 'Yachiyo could not start',
    message: 'The local runtime could not be started.',
    genericDetail: 'Check the application log for details, then restart Yachiyo.',
    linuxCredentialDetail:
      'A secure credential store is unavailable. Start Yachiyo in a Linux desktop session with D-Bus and an unlocked GNOME Keyring or KWallet, then restart the app. Plain-text credential storage is not supported.',
    credentialDetail:
      'The system credential store is unavailable or locked. Unlock it in your desktop session, then restart Yachiyo.',
    nativePackagedDetail:
      'The SQLite native module is missing or incompatible with this Electron build. Reinstall the Yachiyo package for your system and architecture.',
    nativeDevelopmentDetail:
      'The SQLite native module is missing or incompatible with Electron. Use the pinned Node/pnpm toolchain, install dependencies, and run pnpm run native:prepare from the repository before starting Yachiyo.',
    quit: 'Quit'
  },
  credentialStorage: {
    title: 'Provider credential storage',
    message: 'Continue with unencrypted provider credentials?',
    existing: 'Separate plaintext credentials exist. Choose storage for this session.',
    detail:
      'Plaintext mode stores API keys and provider private keys unencrypted in provider-credentials.plaintext.json. Anyone or any process with access to that file can read them. Existing encrypted credentials stay untouched and are unavailable in plaintext mode. The two stores are never merged automatically. Remote access is unavailable in plaintext mode. Quit is the default.',
    plaintext: 'Use plaintext for this session',
    encrypted: 'Use encrypted credentials'
  },
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
    exportProviderBackup: 'Export encrypted provider backup',
    importProviderBackup: 'Import encrypted provider backup',
    providerBackupFilter: 'Yachiyo provider backup',
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
