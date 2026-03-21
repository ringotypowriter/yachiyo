import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createEditableContextMenuTemplate,
  installEditableContextMenu
} from './editableContextMenu.ts'

test('createEditableContextMenuTemplate returns no menu for non-editable targets', () => {
  const template = createEditableContextMenuTemplate({
    isEditable: false,
    editFlags: {
      canUndo: false,
      canRedo: false,
      canCut: false,
      canCopy: false,
      canPaste: false,
      canSelectAll: false
    }
  })

  assert.equal(template, null)
})

test('createEditableContextMenuTemplate mirrors Electron edit capabilities', () => {
  const template = createEditableContextMenuTemplate({
    isEditable: true,
    editFlags: {
      canUndo: true,
      canRedo: false,
      canCut: false,
      canCopy: true,
      canPaste: true,
      canSelectAll: true
    }
  })

  assert.deepEqual(template, [
    { role: 'undo', enabled: true },
    { role: 'redo', enabled: false },
    { type: 'separator' },
    { role: 'cut', enabled: false },
    { role: 'copy', enabled: true },
    { role: 'paste', enabled: true },
    { type: 'separator' },
    { role: 'selectAll', enabled: true }
  ])
})

test('installEditableContextMenu pops up the menu only for editable targets', () => {
  let listener: ((event: Electron.Event, params: Electron.ContextMenuParams) => void) | undefined
  const templates: Electron.MenuItemConstructorOptions[][] = []
  const popupWindows: unknown[] = []
  const window = {
    webContents: {
      on: (
        eventName: string,
        handler: (event: Electron.Event, params: Electron.ContextMenuParams) => void
      ): void => {
        assert.equal(eventName, 'context-menu')
        listener = handler
      }
    }
  } as unknown as Electron.BrowserWindow

  installEditableContextMenu(window, {
    buildMenu: (template) => {
      templates.push(template)
      return {
        popup: (options) => {
          popupWindows.push(options?.window)
        }
      }
    }
  })

  assert.ok(listener)

  listener(
    {} as Electron.Event,
    {
      isEditable: false,
      editFlags: {
        canUndo: false,
        canRedo: false,
        canCut: false,
        canCopy: false,
        canPaste: false,
        canSelectAll: false
      }
    } as Electron.ContextMenuParams
  )

  listener(
    {} as Electron.Event,
    {
      isEditable: true,
      editFlags: {
        canUndo: true,
        canRedo: true,
        canCut: true,
        canCopy: true,
        canPaste: true,
        canSelectAll: true
      }
    } as Electron.ContextMenuParams
  )

  assert.equal(templates.length, 1)
  assert.equal(popupWindows.length, 1)
  assert.equal(popupWindows[0], window)
})
