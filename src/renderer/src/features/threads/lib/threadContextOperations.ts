import type { ThreadColorTag } from '../../../../../shared/yachiyo/protocol.ts'
import { THREAD_COLOR_LABELS, THREAD_COLOR_TAGS } from './threadColorPalette.ts'

export type ThreadContextOperationKey =
  | 'enter-select-mode'
  | 'rename'
  | 'regenerate-title'
  | 'compact-to-another-thread'
  | 'create-folder'
  | 'remove-from-folder'
  | 'archive'
  | 'restore'
  | 'delete'
  | 'star'
  | 'unstar'
  | 'set-color-default'
  | `set-color-${ThreadColorTag}`

export interface ThreadContextOperation {
  active?: boolean
  disabled?: boolean
  key: ThreadContextOperationKey
  label: string
  separatorBefore?: boolean
  tone?: 'danger' | 'default'
}

export function resolveThreadColorOperationTag(
  operationKey: ThreadContextOperationKey
): ThreadColorTag | null | undefined {
  if (operationKey === 'set-color-default') {
    return null
  }

  if (!operationKey.startsWith('set-color-')) {
    return undefined
  }

  const colorTag = operationKey.slice('set-color-'.length) as ThreadColorTag
  return THREAD_COLOR_TAGS.includes(colorTag) ? colorTag : undefined
}

export function resolveThreadContextOperations(input: {
  canHandoff?: boolean
  colorTag?: ThreadColorTag | null
  includeSelectMode?: boolean
  isArchived: boolean
  isExternal?: boolean
  isInFolder?: boolean
  isRenameDisabled?: boolean
  isRunning?: boolean
  isSaving?: boolean
  isStarred?: boolean
}): ThreadContextOperation[] {
  if (input.isArchived) {
    return [
      ...(input.includeSelectMode
        ? ([
            {
              disabled: input.isSaving,
              key: 'enter-select-mode',
              label: 'Select'
            }
          ] satisfies ThreadContextOperation[])
        : []),
      {
        disabled: input.isSaving,
        key: 'restore',
        label: 'Continue Chat'
      },
      {
        disabled: input.isSaving,
        key: 'delete',
        label: 'Delete',
        tone: 'danger'
      }
    ]
  }

  const operations: ThreadContextOperation[] = [
    {
      disabled: input.isSaving,
      key: input.isStarred ? 'unstar' : 'star',
      label: input.isStarred ? 'Unstar' : 'Star'
    },
    ...(input.includeSelectMode
      ? ([
          {
            disabled: input.isSaving,
            key: 'enter-select-mode',
            label: 'Select'
          }
        ] satisfies ThreadContextOperation[])
      : []),
    {
      disabled: input.isSaving || input.isRenameDisabled,
      key: 'rename',
      label: 'Rename'
    }
  ]
  const canHandoff = !input.isExternal && (input.canHandoff ?? true)

  if (!input.isExternal) {
    operations.push({
      disabled: input.isSaving,
      key: 'regenerate-title',
      label: 'Regenerate Title'
    })
  }

  if (canHandoff) {
    operations.push({
      disabled: input.isSaving || input.isRunning,
      key: 'compact-to-another-thread',
      label: 'Handoff'
    })
  }

  if (!input.isExternal) {
    if (input.isInFolder) {
      operations.push({
        disabled: input.isSaving,
        key: 'remove-from-folder',
        label: 'Remove from Folder'
      })
    } else {
      operations.push({
        disabled: input.isSaving,
        key: 'create-folder',
        label: 'Create Folder'
      })
    }
  }

  if (!input.isExternal) {
    operations.push({
      disabled: input.isSaving,
      key: 'archive',
      label: 'Archive'
    })
  }

  if (!input.isInFolder) {
    operations.push(
      {
        active: input.colorTag == null,
        disabled: input.isSaving,
        key: 'set-color-default',
        label: 'Mark it Default',
        separatorBefore: true
      },
      ...THREAD_COLOR_TAGS.map(
        (colorTag): ThreadContextOperation => ({
          active: input.colorTag === colorTag,
          disabled: input.isSaving,
          key: `set-color-${colorTag}`,
          label: THREAD_COLOR_LABELS[colorTag]
        })
      )
    )
  }

  operations.push({
    disabled: input.isSaving,
    key: 'delete',
    label: 'Delete',
    separatorBefore: !input.isInFolder,
    tone: 'danger'
  })

  return operations
}
