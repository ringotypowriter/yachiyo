import {
  classifyAttachmentFileSelection,
  toAttachmentFileRejectionRecords,
  type AttachmentFileRejectionRecord
} from '@yachiyo/shared/attachmentFileTypes'
import type { DiscoveredApp, DiscoveredApps } from '@yachiyo/shared/discoveredApp'
import type { ResolvedFileReference, ResolveFileReferencesInput } from '@yachiyo/shared/protocol'
import { resolveExistingFileReferences } from '@yachiyo/runtime/runtime/files/inlineCodeFileReferences'
import { IPC_CHANNELS } from './ipcChannels.ts'
import { discoverApps, findDiscoveredApp, launchDiscoveredApp } from '../electron/appDiscovery.ts'

type GatewayIpcHandler = <Args extends unknown[], Result>(
  channel: string,
  listener: (...args: Args) => Result | Promise<Result>
) => void

export interface OpenFileSelectionInput {
  path: string
  appSelection?: string
  appKind?: 'editor' | 'markdown'
  threadId?: string
  workspacePath?: string | null
  workspaceOnly?: boolean
}

interface OpenFileSelectionDependencies {
  discoverApps: () => Promise<DiscoveredApps>
  launchApp: (app: DiscoveredApp, input: { targetPath: string }) => Promise<void>
  openPath: (path: string) => Promise<string>
  resolveFileReferences: (input: ResolveFileReferencesInput) => Promise<ResolvedFileReference[]>
}

interface RevealFileSelectionDependencies {
  revealPath: (path: string) => void
  resolveFileReferences: (input: ResolveFileReferencesInput) => Promise<ResolvedFileReference[]>
}

export async function openFileUsingSelection(
  input: OpenFileSelectionInput,
  dependencies: OpenFileSelectionDependencies
): Promise<void> {
  const targetPath = await resolveFileOperationPath(input, dependencies.resolveFileReferences)

  if (input.appSelection) {
    if (!input.appKind) {
      throw new Error('A configured application kind is required.')
    }
    const app = findDiscoveredApp(await dependencies.discoverApps(), input.appSelection, [
      input.appKind
    ])
    if (!app) throw new Error(`Application "${input.appSelection}" is not installed.`)
    await dependencies.launchApp(app, { targetPath })
    return
  }

  if (input.appKind) {
    throw new Error('A configured application selection is required.')
  }
  const error = await dependencies.openPath(targetPath)
  if (error) throw new Error(error)
}

export async function revealFileUsingSelection(
  input: OpenFileSelectionInput,
  dependencies: RevealFileSelectionDependencies
): Promise<void> {
  const targetPath = await resolveFileOperationPath(input, dependencies.resolveFileReferences)
  dependencies.revealPath(targetPath)
}

async function resolveFileOperationPath(
  input: {
    path: string
    threadId?: string
    workspacePath?: string | null
    workspaceOnly?: boolean
  },
  resolveFileReferences: (input: ResolveFileReferencesInput) => Promise<ResolvedFileReference[]>
): Promise<string> {
  if (!input.workspaceOnly) return input.path

  const [resolved] = await resolveFileReferences({
    ...(input.threadId ? { threadId: input.threadId } : {}),
    workspacePath: input.workspacePath ?? null,
    workspaceOnly: true,
    references: [input.path]
  })
  if (!resolved) {
    throw new Error('The file is no longer available inside this workspace.')
  }
  return resolved.path
}

export function registerGatewayFileHandlers(handle: GatewayIpcHandler): void {
  handle(IPC_CHANNELS.readClipboardFilePaths, async () => {
    const { clipboard } = await import('electron')
    const { readFile, stat } = await import('node:fs/promises')
    const { basename, extname } = await import('node:path')

    const acceptedImageExtensions: Record<string, string> = {
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.gif': 'image/gif',
      '.webp': 'image/webp'
    }

    const readFn = (clipboard as unknown as { readFilePaths?: () => string[] }).readFilePaths
    const paths: string[] = typeof readFn === 'function' ? readFn.call(clipboard) : []
    const files: { filename: string; mediaType: string; dataUrl: string }[] = []
    const rejected: AttachmentFileRejectionRecord[] = []

    for (const filePath of paths) {
      const ext = extname(filePath).toLowerCase()
      const filename = basename(filePath)
      const imageMediaType = acceptedImageExtensions[ext]
      let mediaType = imageMediaType

      if (!mediaType) {
        const fileStat = await stat(filePath)
        const classified = classifyAttachmentFileSelection([
          { name: filename, size: fileStat.size }
        ])
        rejected.push(...toAttachmentFileRejectionRecords(classified.rejected))
        mediaType = classified.accepted[0]?.mediaType
      }

      if (!mediaType) {
        continue
      }

      const data = await readFile(filePath)
      const base64 = data.toString('base64')
      files.push({
        filename,
        mediaType,
        dataUrl: `data:${mediaType};base64,${base64}`
      })
    }

    return { files, rejected }
  })

  handle(
    IPC_CHANNELS.readAttachmentFile,
    async (input: { filePath: string; mediaType: string }) => {
      const { readFile } = await import('node:fs/promises')
      const data = await readFile(input.filePath)
      const base64 = data.toString('base64')
      return `data:${input.mediaType};base64,${base64}`
    }
  )

  handle(
    IPC_CHANNELS.revealFile,
    async (input: {
      path: string
      threadId?: string
      workspacePath?: string | null
      workspaceOnly?: boolean
    }) => {
      const { shell } = await import('electron')
      await revealFileUsingSelection(input, {
        revealPath: (path) => shell.showItemInFolder(path),
        resolveFileReferences: resolveExistingFileReferences
      })
    }
  )

  handle(IPC_CHANNELS.resolveFileReferences, (input: ResolveFileReferencesInput) =>
    resolveExistingFileReferences(input)
  )

  handle(IPC_CHANNELS.openFile, async (input: OpenFileSelectionInput) => {
    const { shell } = await import('electron')
    await openFileUsingSelection(input, {
      discoverApps,
      launchApp: launchDiscoveredApp,
      openPath: (path) => shell.openPath(path),
      resolveFileReferences: resolveExistingFileReferences
    })
  })

  handle(IPC_CHANNELS.copyImageToClipboard, async (input: { src: string }) => {
    const { clipboard, nativeImage, net } = await import('electron')
    const src = input.src

    let buffer: Buffer
    if (/^https?:\/\//i.test(src) || src.startsWith('yachiyo-asset://')) {
      const resp = await net.fetch(src)
      if (!resp.ok) throw new Error(`Failed to fetch image: ${resp.status}`)
      buffer = Buffer.from(await resp.arrayBuffer())
    } else if (src.startsWith('data:image/')) {
      const base64 = src.split(',')[1]
      if (!base64) throw new Error('Invalid data URL')
      buffer = Buffer.from(base64, 'base64')
    } else {
      const fs = await import('node:fs/promises')
      buffer = Buffer.from(await fs.readFile(src))
    }

    const image = nativeImage.createFromBuffer(buffer)
    if (image.isEmpty()) throw new Error('Could not decode image')
    clipboard.writeImage(image)
  })
}
