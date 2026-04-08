export type ThreadContextOperationKey =
  | 'enter-select-mode'
  | 'rename'
  | 'regenerate-title'
  | 'compact-to-another-thread'
  | 'archive'
  | 'restore'
  | 'delete'
  | 'star'
  | 'unstar'

export interface ThreadContextOperation {
  disabled?: boolean
  key: ThreadContextOperationKey
  label: string
  tone?: 'danger' | 'default'
}

export function resolveThreadContextOperations(input: {
  includeSelectMode?: boolean
  isArchived: boolean
  isExternal?: boolean
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

  if (!input.isExternal) {
    operations.push({
      disabled: input.isSaving,
      key: 'regenerate-title',
      label: 'Regenerate Title'
    })
  }

  operations.push({
    disabled: input.isSaving || input.isRunning,
    key: 'compact-to-another-thread',
    label: 'Handoff'
  })

  if (!input.isExternal) {
    operations.push({
      disabled: input.isSaving,
      key: 'archive',
      label: 'Archive'
    })
  }

  operations.push({
    disabled: input.isSaving,
    key: 'delete',
    label: 'Delete',
    tone: 'danger'
  })

  return operations
}
