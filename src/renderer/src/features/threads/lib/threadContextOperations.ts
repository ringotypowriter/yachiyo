export type ThreadContextOperationKey =
  | 'enter-select-mode'
  | 'rename'
  | 'regenerate-title'
  | 'compact-to-another-thread'
  | 'save-thread'
  | 'archive'
  | 'restore'
  | 'delete'

export interface ThreadContextOperation {
  disabled?: boolean
  key: ThreadContextOperationKey
  label: string
  tone?: 'danger' | 'default'
}

export function resolveThreadContextOperations(input: {
  isArchived: boolean
  isMemoryEnabled?: boolean
  isRenameDisabled?: boolean
}): ThreadContextOperation[] {
  if (input.isArchived) {
    return [
      {
        key: 'enter-select-mode',
        label: 'Select'
      },
      {
        key: 'restore',
        label: 'Restore'
      },
      {
        key: 'regenerate-title',
        label: 'Regenerate Title'
      },
      {
        key: 'delete',
        label: 'Delete',
        tone: 'danger'
      }
    ]
  }

  return [
    {
      key: 'enter-select-mode',
      label: 'Select'
    },
    {
      disabled: input.isRenameDisabled,
      key: 'rename',
      label: 'Rename'
    },
    {
      key: 'regenerate-title',
      label: 'Regenerate Title'
    },
    {
      key: 'compact-to-another-thread',
      label: 'Handoff'
    },
    ...(input.isMemoryEnabled
      ? [
          {
            key: 'save-thread' as const,
            label: 'Save Thread'
          }
        ]
      : []),
    {
      key: 'archive',
      label: 'Archive'
    },
    {
      key: 'delete',
      label: 'Delete',
      tone: 'danger'
    }
  ]
}
