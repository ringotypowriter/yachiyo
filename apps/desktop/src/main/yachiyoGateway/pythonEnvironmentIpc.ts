import type {
  ManagedPythonEnvironmentAction,
  ManagedPythonEnvironmentStatus
} from '@yachiyo/shared/protocol'

import { handleYachiyoIpc } from './ipc.ts'
import { IPC_CHANNELS } from './ipcChannels.ts'

interface PythonEnvironmentRpc {
  getPythonEnvironmentStatus(): Promise<ManagedPythonEnvironmentStatus>
  managePythonEnvironment(
    action: ManagedPythonEnvironmentAction
  ): Promise<ManagedPythonEnvironmentStatus>
}

export function registerPythonEnvironmentIpc(getRpc: () => PythonEnvironmentRpc): void {
  handleYachiyoIpc(IPC_CHANNELS.getPythonEnvironmentStatus, () =>
    getRpc().getPythonEnvironmentStatus()
  )
  handleYachiyoIpc(
    IPC_CHANNELS.managePythonEnvironment,
    (input: { action: ManagedPythonEnvironmentAction }) =>
      getRpc().managePythonEnvironment(input.action)
  )
}
