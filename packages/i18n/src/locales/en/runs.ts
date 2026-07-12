export const runs = {
  runHistory: 'Run History',
  noRunsYet: 'No runs yet',
  latest: 'latest',
  restore: 'Restore',
  restoring: 'Restoring…',
  fileChanges: { one: '{count} file change', other: '{count} file changes' },
  restoreToCheckpoint: 'Restore to checkpoint',
  restoreCheckpointDescription:
    'This will revert all files to their state before this run and destroy all snapshots after it. This cannot be undone.',
  status: {
    running: 'Running',
    completed: 'Completed',
    failed: 'Failed',
    cancelled: 'Cancelled'
  },
  serverUnavailable: 'Local server is unavailable. Reload the app if this keeps happening.',
  setupRequired: 'Open Settings to configure a provider and model before chatting.'
} as const
