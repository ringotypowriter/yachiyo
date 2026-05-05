import { spawn } from 'child_process'

import {
  classifyAttachmentFileSelection,
  toAttachmentFileRejectionRecords,
  type AttachmentFileRejectionRecord
} from '../../shared/yachiyo/attachmentFileTypes.ts'
import type { ResolveFileReferencesInput } from '../../shared/yachiyo/protocol'
import { resolveExistingFileReferences } from '../yachiyo-server/runtime/inlineCodeFileReferences.ts'
import { IPC_CHANNELS } from './ipcChannels.ts'

type GatewayIpcHandler = <Args extends unknown[], Result>(
  channel: string,
  listener: (...args: Args) => Result | Promise<Result>
) => void

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

  handle(IPC_CHANNELS.revealFile, async (input: { path: string }) => {
    const { shell } = await import('electron')
    shell.showItemInFolder(input.path)
  })

  handle(IPC_CHANNELS.resolveFileReferences, (input: ResolveFileReferencesInput) =>
    resolveExistingFileReferences(input)
  )

  handle(IPC_CHANNELS.openFile, async (input: { path: string }) => {
    const { shell } = await import('electron')
    const error = await shell.openPath(input.path)
    if (error) {
      throw new Error(error)
    }
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

  handle(IPC_CHANNELS.openFileInEditor, async (input: { path: string; editorApp: string }) => {
    await new Promise<void>((resolve, reject) => {
      const chunks: Buffer[] = []
      const child = spawn('open', ['-a', input.editorApp, input.path])
      child.stderr.on('data', (d: Buffer) => chunks.push(d))
      child.on('close', (code) => {
        if (code === 0) resolve()
        else {
          const stderr = Buffer.concat(chunks).toString().trim()
          reject(new Error(stderr || `Failed to open "${input.editorApp}" (exit code ${code})`))
        }
      })
      child.on('error', reject)
    })
  })
}
