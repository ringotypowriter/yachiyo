export type ThreadContextOperationKey =
  | 'rename'
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
        key: 'restore',
        label: 'Restore'
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
      disabled: input.isRenameDisabled,
      key: 'rename',
      label: 'Rename'
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
