import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { BrowserWindow, IpcMain } from 'electron'
import { IPC_CHANNELS } from './ipcChannels.ts'
import { normalizePngBytes, normalizePngFilename } from './pngFile.ts'

export const MAX_PNG_EXPORT_PAGES = 30
export const MAX_PNG_EXPORT_BYTES = 128 * 1024 * 1024

export interface SavePngFilesInput {
  pages: (ArrayBuffer | Uint8Array)[]
  filenamePrefix?: string
}

export type SavePngFilesResult =
  | { canceled: true }
  | { canceled: false; directoryPath: string; filePaths: string[] }

export interface PngExportDependencies {
  chooseDirectory: () => Promise<string | undefined>
  filesystem?: {
    mkdtemp: typeof mkdtemp
    writeFile: typeof writeFile
    rm: typeof rm
  }
}

// No renderer-supplied path is used: only the native picker selects the parent.
export async function savePngFiles(
  input: SavePngFilesInput,
  { chooseDirectory, filesystem = { mkdtemp, writeFile, rm } }: PngExportDependencies
): Promise<SavePngFilesResult> {
  if (!input || !Array.isArray(input.pages) || input.pages.length === 0) {
    throw new Error('PNG export requires at least one page.')
  }
  if (input.pages.length > MAX_PNG_EXPORT_PAGES) {
    throw new Error(`PNG export supports at most ${MAX_PNG_EXPORT_PAGES} pages.`)
  }
  let totalBytes = 0
  for (const page of input.pages) {
    if (!(page instanceof ArrayBuffer) && !(page instanceof Uint8Array)) {
      throw new Error('PNG export data must be a valid PNG image.')
    }
    totalBytes += page.byteLength
    if (totalBytes > MAX_PNG_EXPORT_BYTES) {
      throw new Error('PNG export data exceeds the 128 MiB limit.')
    }
  }
  if (input.filenamePrefix !== undefined && typeof input.filenamePrefix !== 'string') {
    throw new Error('PNG export filename prefix must be a string.')
  }
  const prefix =
    normalizePngFilename(input.filenamePrefix)
      .slice(0, -4)
      // Control characters are intentionally removed from filesystem names.
      // eslint-disable-next-line no-control-regex
      .replace(/[<>:"|?*\u0000-\u001f]/g, '-')
      .slice(0, 100)
      .replace(/[. ]+$/g, '') || 'diagram'
  const pages = input.pages.map(normalizePngBytes)
  const parentDirectory = await chooseDirectory()
  if (!parentDirectory) return { canceled: true }

  // mkdtemp creates an exclusive new directory, never reusing an existing export.
  // Keep it outside the try so a creation failure cannot trigger cleanup of the parent.
  const directoryPath = await filesystem.mkdtemp(join(parentDirectory, `${prefix}-`))
  const filePaths: string[] = []
  try {
    for (let index = 0; index < pages.length; index += 1) {
      const filePath = join(directoryPath, `${prefix}-${String(index + 1).padStart(2, '0')}.png`)
      await filesystem.writeFile(filePath, pages[index], { flag: 'wx' })
      filePaths.push(filePath)
    }
    return { canceled: false, directoryPath, filePaths }
  } catch (error) {
    try {
      await filesystem.rm(directoryPath, { recursive: true, force: true })
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        'PNG export failed and cleanup was incomplete.'
      )
    }
    throw error
  }
}

export function registerPngExportHandlers(ipcMain: IpcMain, windows: typeof BrowserWindow): void {
  ipcMain.removeHandler(IPC_CHANNELS.savePngFiles)
  ipcMain.handle(IPC_CHANNELS.savePngFiles, async (event, input: SavePngFilesInput) => {
    const { dialog } = await import('electron')
    const win = windows.fromWebContents(event.sender)
    if (!win || win.isDestroyed()) {
      throw new Error('Unable to save PNG: source window is unavailable.')
    }
    return savePngFiles(input, {
      chooseDirectory: async () => {
        const result = await dialog.showOpenDialog(win, {
          properties: ['openDirectory', 'createDirectory']
        })
        return result.canceled ? undefined : result.filePaths[0]
      }
    })
  })
}
