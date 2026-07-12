import { t } from '@yachiyo/i18n/index'
import type { ThreadColorTag } from '@yachiyo/shared/protocol'
import { THREAD_COLOR_TAGS, threadColorMarkLabel } from './threadColorPalette.ts'

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
              label: t('threads.contextMenu.select')
            }
          ] satisfies ThreadContextOperation[])
        : []),
      {
        disabled: input.isSaving,
        key: 'restore',
        label: t('threads.contextMenu.continueChat')
      },
      {
        disabled: input.isSaving,
        key: 'delete',
        label: t('common.delete'),
        tone: 'danger'
      }
    ]
  }

  const operations: ThreadContextOperation[] = [
    {
      disabled: input.isSaving,
      key: input.isStarred ? 'unstar' : 'star',
      label: input.isStarred ? t('threads.contextMenu.unstar') : t('threads.contextMenu.star')
    },
    ...(input.includeSelectMode
      ? ([
          {
            disabled: input.isSaving,
            key: 'enter-select-mode',
            label: t('threads.contextMenu.select')
          }
        ] satisfies ThreadContextOperation[])
      : []),
    {
      disabled: input.isSaving || input.isRenameDisabled,
      key: 'rename',
      label: t('common.rename')
    }
  ]
  const canHandoff = !input.isExternal && (input.canHandoff ?? true)

  if (!input.isExternal) {
    operations.push({
      disabled: input.isSaving,
      key: 'regenerate-title',
      label: t('threads.contextMenu.regenerateTitle')
    })
  }

  if (canHandoff) {
    operations.push({
      disabled: input.isSaving || input.isRunning,
      key: 'compact-to-another-thread',
      label: t('threads.contextMenu.handoff')
    })
  }

  if (!input.isExternal) {
    if (input.isInFolder) {
      operations.push({
        disabled: input.isSaving,
        key: 'remove-from-folder',
        label: t('threads.contextMenu.removeFromFolder')
      })
    } else {
      operations.push({
        disabled: input.isSaving,
        key: 'create-folder',
        label: t('threads.contextMenu.createFolder')
      })
    }
  }

  if (!input.isExternal) {
    operations.push({
      disabled: input.isSaving,
      key: 'archive',
      label: t('threads.actions.archive')
    })
  }

  if (!input.isInFolder) {
    operations.push(
      {
        active: input.colorTag == null,
        disabled: input.isSaving,
        key: 'set-color-default',
        label: threadColorMarkLabel(null),
        separatorBefore: true
      },
      ...THREAD_COLOR_TAGS.map(
        (colorTag): ThreadContextOperation => ({
          active: input.colorTag === colorTag,
          disabled: input.isSaving,
          key: `set-color-${colorTag}`,
          label: threadColorMarkLabel(colorTag)
        })
      )
    )
  }

  operations.push({
    disabled: input.isSaving,
    key: 'delete',
    label: t('common.delete'),
    separatorBefore: !input.isInFolder,
    tone: 'danger'
  })

  return operations
}
