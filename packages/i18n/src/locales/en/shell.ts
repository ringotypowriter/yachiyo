export const shell = {
  loadingSettings: 'Loading settings…',
  startingUp: 'Starting up…',
  wakingUp: 'Yachiyo is waking up',
  unableToConnect: 'Unable to connect',
  waitingForLocalServer: 'Waiting for the local server',
  plaintextCredentialsWarning:
    'Plaintext credential mode: API keys are stored unencrypted and readable by any process with file access. Remote requires encrypted mode and an unlocked system wallet.',
  ok: 'OK',
  processing: 'Processing',
  whatsNew: "What's new in v{version}",
  noReleaseNotes: 'No release notes available.',
  releaseNotesFailed: 'Failed to load release notes.',
  rendererError: {
    title: 'Something went wrong',
    description: 'This window hit an unexpected error. Reloading usually fixes it.',
    reload: 'Reload window'
  },
  runtimeCrash: {
    title: 'Assistant runtime stopped',
    description: 'The local runtime crashed repeatedly and automatic restarts were paused.',
    restart: 'Restart runtime',
    openLogs: 'View logs'
  }
} as const
