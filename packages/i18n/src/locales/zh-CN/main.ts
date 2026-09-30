export const main = {
  startupFailure: {
    title: 'Yachiyo 无法启动',
    message: '无法启动本地运行时。',
    genericDetail: '请查看应用日志了解详情，然后重新启动 Yachiyo。',
    linuxCredentialDetail:
      '安全凭据存储不可用。请在具有 D-Bus 且已解锁 GNOME Keyring 或 KWallet 的 Linux 桌面会话中运行 Yachiyo，然后重启应用。不支持以明文保存凭据。',
    credentialDetail: '系统凭据存储不可用或已锁定。请在桌面会话中将其解锁，然后重启 Yachiyo。',
    nativePackagedDetail:
      'SQLite 原生模块缺失或与当前 Electron 不兼容。请重新安装适用于当前系统和架构的 Yachiyo 安装包。',
    nativeDevelopmentDetail:
      'SQLite 原生模块缺失或与 Electron 不兼容。请使用项目指定的 Node/pnpm 版本安装依赖，并在仓库中运行 pnpm run native:prepare 后再启动 Yachiyo。',
    quit: '退出'
  },
  credentialStorage: {
    title: '提供商凭据存储',
    message: '是否使用明文凭据继续？',
    existing: '已有独立的明文凭据，请选择本次运行使用的存储方式。',
    detail:
      '明文模式将 API key 和提供商私钥以未加密形式保存在 provider-credentials.plaintext.json。有权访问该文件的人或进程都能读取。已有加密凭据保持不变，明文模式无法使用它们。两套存储不会自动合并。明文模式无法使用远程访问。默认操作为退出。',
    plaintext: '本次使用明文模式',
    encrypted: '使用加密凭据'
  },
  menu: {
    settings: '设置…',
    file: '文件',
    edit: '编辑',
    view: '显示',
    window: '窗口',
    help: '帮助'
  },
  closeGuard: {
    title: '有正在进行的运行',
    message: {
      other: '{count} 个运行仍在进行。'
    },
    detail: {
      other: '要停止运行并关闭此窗口吗？'
    },
    stopAndClose: '停止运行并关闭'
  },
  dialogs: {
    exportProviderBackup: '导出加密服务商备份',
    importProviderBackup: '导入加密服务商备份',
    providerBackupFilter: 'Yachiyo 服务商备份',
    selectSessionFile: '选择会话文件',
    selectWorkspace: '选择工作区',
    selectSyncFolder: '选择同步文件夹',
    pngImageFilter: 'PNG 图片'
  },
  cli: {
    installedTitle: 'Yachiyo CLI 已安装',
    readySymlinked: 'yachiyo 命令已就绪，在任意终端里试试吧！',
    readyRestart: '重启终端（或运行 `source ~/.zshrc`）后即可使用 yachiyo 命令。'
  }
} as const
