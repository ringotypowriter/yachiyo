export type ThreadContextOperationKey = 'rename' | 'archive' | 'restore' | 'delete'

export interface ThreadContextOperation {
  disabled?: boolean
  key: ThreadContextOperationKey
  label: string
  tone?: 'danger' | 'default'
}

export function resolveThreadContextOperations(input: {
  isArchived: boolean
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
