import { mkdir, readdir, readFile, stat, writeFile, unlink, open } from 'node:fs/promises'
import { join } from 'node:path'
import type { JotdownFull, JotdownMeta, JotdownSaveInput } from '../../../shared/yachiyo/protocol'

export function filenameToISODate(stem: string): string {
  const [datePart, timePart] = stem.split('_')
  if (!datePart || !timePart) return new Date().toISOString()
  // timePart is "HH-mm-ss-SSS" or legacy "HH-mm-ss"
  const segments = timePart.split('-')
  const time = segments.slice(0, 3).join(':')
  const ms = segments[3] ? `.${segments[3]}` : ''
  return `${datePart}T${time}${ms}`
}

export function extractTitle(content: string): string {
  const firstLine = content.split('\n').find((l) => l.trim().length > 0)
  return (
    firstLine
      ?.replace(/^#+\s*/, '')
      .trim()
      .slice(0, 80) || '(untitled)'
  )
}

function generateId(now: Date): string {
  const pad = (n: number, len = 2): string => String(n).padStart(len, '0')
  return (
    `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}` +
    `_${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}` +
    `-${pad(now.getMilliseconds(), 3)}`
  )
}

export interface JotdownStore {
  baseDir: string
  list(): Promise<JotdownMeta[]>
  load(id: string): Promise<JotdownFull>
  create(): Promise<JotdownFull>
  save(input: JotdownSaveInput): Promise<JotdownMeta>
  delete(id: string): Promise<void>
  getLatest(): Promise<JotdownFull | null>
}

export function createJotdownStore(baseDir: string): JotdownStore {
  async function ensureDir(): Promise<void> {
    await mkdir(baseDir, { recursive: true })
  }

  return {
    baseDir,

    async list(): Promise<JotdownMeta[]> {
      await ensureDir()
      const files = (await readdir(baseDir)).filter((f) => f.endsWith('.md'))
      const metas = await Promise.all(
        files.map(async (f) => {
          const id = f.replace(/\.md$/, '')
          const filePath = join(baseDir, f)
          const content = await readFile(filePath, 'utf8')
          const st = await stat(filePath)
          return {
            id,
            title: extractTitle(content),
            createdAt: filenameToISODate(id),
            modifiedAt: st.mtime.toISOString()
          }
        })
      )
      return metas.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    },

    async load(id: string): Promise<JotdownFull> {
      const filePath = join(baseDir, `${id}.md`)
      const content = await readFile(filePath, 'utf8')
      const st = await stat(filePath)
      return {
        id,
        title: extractTitle(content),
        content,
        createdAt: filenameToISODate(id),
        modifiedAt: st.mtime.toISOString()
      }
    },

    async create(): Promise<JotdownFull> {
      await ensureDir()
      const now = new Date()
      const baseId = generateId(now)

      // Use exclusive-create flag to detect collisions, then append a
      // counter suffix until we find a free filename.
      let id = baseId
      for (let attempt = 0; ; attempt++) {
        const filePath = join(baseDir, `${id}.md`)
        try {
          const fh = await open(filePath, 'wx')
          await fh.close()
          break
        } catch (err: unknown) {
          if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
          id = `${baseId}-${attempt + 1}`
        }
      }

      return {
        id,
        title: '(untitled)',
        content: '',
        createdAt: filenameToISODate(id),
        modifiedAt: now.toISOString()
      }
    },

    async save(input: JotdownSaveInput): Promise<JotdownMeta> {
      const filePath = join(baseDir, `${input.id}.md`)
      await writeFile(filePath, input.content, 'utf8')
      const st = await stat(filePath)
      return {
        id: input.id,
        title: extractTitle(input.content),
        createdAt: filenameToISODate(input.id),
        modifiedAt: st.mtime.toISOString()
      }
    },

    async delete(id: string): Promise<void> {
      await unlink(join(baseDir, `${id}.md`))
    },

    async getLatest(): Promise<JotdownFull | null> {
      await ensureDir()
      const files = (await readdir(baseDir)).filter((f) => f.endsWith('.md'))
      if (files.length === 0) return null
      const sorted = files.sort((a, b) => b.localeCompare(a))
      const id = sorted[0]!.replace(/\.md$/, '')
      return this.load(id)
    }
  }
}
