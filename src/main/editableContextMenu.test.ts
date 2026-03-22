import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createEditableContextMenuTemplate,
  installEditableContextMenu
} from './editableContextMenu.ts'

test('createEditableContextMenuTemplate returns no menu for non-editable targets', () => {
  const template = createEditableContextMenuTemplate({
    isEditable: false,
    selectionText: '',
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
    selectionText: '',
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

test('createEditableContextMenuTemplate exposes copy actions for selected read-only text', () => {
  const template = createEditableContextMenuTemplate({
    isEditable: false,
    selectionText: 'selected text',
    editFlags: {
      canUndo: false,
      canRedo: false,
      canCut: false,
      canCopy: true,
      canPaste: false,
      canSelectAll: true
    }
  })

  assert.deepEqual(template, [
    { role: 'copy', enabled: true },
    { type: 'separator' },
    { role: 'selectAll', enabled: true }
  ])
})

test('installEditableContextMenu pops up the menu for editable fields and selected read-only text', () => {
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
      selectionText: '',
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
      selectionText: '',
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

  listener(
    {} as Electron.Event,
    {
      isEditable: false,
      selectionText: 'selected text',
      editFlags: {
        canUndo: false,
        canRedo: false,
        canCut: false,
        canCopy: true,
        canPaste: false,
        canSelectAll: true
      }
    } as Electron.ContextMenuParams
  )

  assert.equal(templates.length, 2)
  assert.equal(popupWindows.length, 2)
  assert.equal(popupWindows[0], window)
  assert.equal(popupWindows[1], window)
})
