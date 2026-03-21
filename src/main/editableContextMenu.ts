import electron from 'electron'

const { Menu } = electron

export interface EditableContextMenuFlags {
  canCopy: boolean
  canCut: boolean
  canPaste: boolean
  canRedo: boolean
  canSelectAll: boolean
  canUndo: boolean
}

export interface EditableContextMenuParams {
  editFlags: EditableContextMenuFlags
  isEditable: boolean
}

export interface EditableContextMenuDependencies {
  buildMenu?: (template: Electron.MenuItemConstructorOptions[]) => Pick<Electron.Menu, 'popup'>
}

export function createEditableContextMenuTemplate(
  params: EditableContextMenuParams
): Electron.MenuItemConstructorOptions[] | null {
  if (!params.isEditable) {
    return null
  }

  const { editFlags } = params

  return [
    { role: 'undo', enabled: editFlags.canUndo },
    { role: 'redo', enabled: editFlags.canRedo },
    { type: 'separator' },
    { role: 'cut', enabled: editFlags.canCut },
    { role: 'copy', enabled: editFlags.canCopy },
    { role: 'paste', enabled: editFlags.canPaste },
    { type: 'separator' },
    { role: 'selectAll', enabled: editFlags.canSelectAll }
  ]
}

export function installEditableContextMenu(
  window: Electron.BrowserWindow,
  dependencies: EditableContextMenuDependencies = {}
): void {
  const buildMenu = dependencies.buildMenu ?? Menu.buildFromTemplate

  window.webContents.on('context-menu', (_, params) => {
    const template = createEditableContextMenuTemplate({
      isEditable: params.isEditable,
      editFlags: {
        canUndo: params.editFlags.canUndo,
        canRedo: params.editFlags.canRedo,
        canCut: params.editFlags.canCut,
        canCopy: params.editFlags.canCopy,
        canPaste: params.editFlags.canPaste,
        canSelectAll: params.editFlags.canSelectAll
      }
    })

    if (!template) {
      return
    }

    buildMenu(template).popup({ window })
  })
}
