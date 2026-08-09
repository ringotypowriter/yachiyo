import type { ProviderConfig } from './protocol.ts'

export const PROVIDER_BACKUP_MIN_PASSWORD_LENGTH = 8

export interface ExportProviderBackupInput {
  password: string
  providers: ProviderConfig[]
}

export type ExportProviderBackupResult = { canceled: true } | { canceled: false; filePath: string }

export interface ImportProviderBackupInput {
  existingProviders: ProviderConfig[]
  password: string
}

export type ImportProviderBackupResult =
  | { canceled: true }
  | {
      canceled: false
      filePath: string
      importedCount: number
      providers: ProviderConfig[]
    }
