import { app, dialog, type FileFilter } from 'electron'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { t } from '@yachiyo/i18n/index'
import {
  decryptProviderBackup,
  encryptProviderBackup,
  mergeProviderBackup
} from '@yachiyo/runtime/settings/providerBackup'
import type {
  ExportProviderBackupInput,
  ExportProviderBackupResult,
  ImportProviderBackupInput,
  ImportProviderBackupResult
} from '@yachiyo/shared/providerBackup'

import { handleYachiyoIpc } from './ipc.ts'
import { IPC_CHANNELS } from './ipcChannels.ts'

const PROVIDER_BACKUP_EXTENSION = 'yachiyo-providers'

function providerBackupFilters(): FileFilter[] {
  return [
    {
      name: t('main.dialogs.providerBackupFilter'),
      extensions: [PROVIDER_BACKUP_EXTENSION]
    }
  ]
}

export function registerProviderBackupHandlers(): void {
  handleYachiyoIpc(
    IPC_CHANNELS.exportProviderBackup,
    async (input: ExportProviderBackupInput): Promise<ExportProviderBackupResult> => {
      const result = await dialog.showSaveDialog({
        defaultPath: join(
          app.getPath('documents'),
          `yachiyo-providers-${new Date().toISOString().slice(0, 10)}.${PROVIDER_BACKUP_EXTENSION}`
        ),
        buttonLabel: t('main.dialogs.exportProviderBackup'),
        filters: providerBackupFilters()
      })
      if (result.canceled || !result.filePath) {
        return { canceled: true }
      }

      await writeFile(
        result.filePath,
        await encryptProviderBackup(input.providers, input.password),
        { encoding: 'utf8', mode: 0o600 }
      )
      return { canceled: false, filePath: result.filePath }
    }
  )

  handleYachiyoIpc(
    IPC_CHANNELS.importProviderBackup,
    async (input: ImportProviderBackupInput): Promise<ImportProviderBackupResult> => {
      const result = await dialog.showOpenDialog({
        defaultPath: app.getPath('documents'),
        properties: ['openFile'],
        buttonLabel: t('main.dialogs.importProviderBackup'),
        filters: providerBackupFilters()
      })
      const filePath = result.filePaths[0]
      if (result.canceled || !filePath) {
        return { canceled: true }
      }

      const importedProviders = await decryptProviderBackup(
        await readFile(filePath, 'utf8'),
        input.password
      )
      return {
        canceled: false,
        filePath,
        importedCount: importedProviders.length,
        providers: mergeProviderBackup(input.existingProviders, importedProviders)
      }
    }
  )
}
