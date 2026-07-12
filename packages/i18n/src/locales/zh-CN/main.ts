export const main = {
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
