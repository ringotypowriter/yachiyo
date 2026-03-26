export type ThreadContextOperationKey =
  | 'enter-select-mode'
  | 'rename'
  | 'regenerate-title'
  | 'compact-to-another-thread'
  | 'save-thread'
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
  isArchived: boolean
  isMemoryEnabled?: boolean
  isRenameDisabled?: boolean
  isSaving?: boolean
  isStarred?: boolean
}): ThreadContextOperation[] {
  if (input.isArchived) {
    return [
      {
        disabled: input.isSaving,
        key: 'restore',
        label: 'Restore'
      },
      {
        disabled: input.isSaving,
        key: 'regenerate-title',
        label: 'Regenerate Title'
      },
      {
        disabled: input.isSaving,
        key: 'delete',
        label: 'Delete',
        tone: 'danger'
      }
    ]
  }

  return [
    {
      disabled: input.isSaving,
      key: input.isStarred ? 'unstar' : 'star',
      label: input.isStarred ? 'Unstar' : 'Star'
    },
    {
      disabled: input.isSaving || input.isRenameDisabled,
      key: 'rename',
      label: 'Rename'
    },
    {
      disabled: input.isSaving,
      key: 'regenerate-title',
      label: 'Regenerate Title'
    },
    {
      disabled: input.isSaving,
      key: 'compact-to-another-thread',
      label: 'Handoff'
    },
    ...(input.isMemoryEnabled
      ? [
          {
            disabled: input.isSaving,
            key: 'save-thread' as const,
            label: input.isSaving ? 'Saving…' : 'Save Thread'
          }
        ]
      : []),
    {
      disabled: input.isSaving,
      key: 'archive',
      label: 'Archive'
    },
    {
      disabled: input.isSaving,
      key: 'delete',
      label: 'Delete',
      tone: 'danger'
    }
  ]
}
