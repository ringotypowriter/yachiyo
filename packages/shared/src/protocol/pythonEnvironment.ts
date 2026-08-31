export type ManagedPythonEnvironmentState =
  | 'not-installed'
  | 'ready'
  | 'needs-repair'
  | 'unavailable'

export type ManagedPythonEnvironmentAction = 'install' | 'repair' | 'rebuild' | 'remove'

export type ManagedPythonEnvironmentPhase =
  | 'checking'
  | 'preparing-helper'
  | 'installing-python'
  | 'creating-environment'
  | 'installing-packages'
  | 'verifying-environment'
  | 'removing-environment'

export type ManagedPythonEnvironmentFailureCode =
  | 'resources-unavailable'
  | 'resources-invalid'
  | 'network'
  | 'permission'
  | 'environment'
  | 'busy'
  | 'cancelled'
  | 'unknown'

export interface ManagedPythonEnvironmentFailure {
  code: ManagedPythonEnvironmentFailureCode
  message: string
  action: ManagedPythonEnvironmentAction
  phase: ManagedPythonEnvironmentPhase
  occurredAt: string
}

export interface ManagedPythonEnvironmentStatus {
  state: ManagedPythonEnvironmentState
  operation?: ManagedPythonEnvironmentAction
  phase?: ManagedPythonEnvironmentPhase
  rootPath: string
  environmentPath: string
  pythonVersion: string
  uvVersion: string
  activeProcessCount: number
  managementBlocked: boolean
  updatedAt: string
  lastFailure?: ManagedPythonEnvironmentFailure
}
