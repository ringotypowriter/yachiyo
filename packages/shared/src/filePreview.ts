export type FilePreviewKind = 'image' | 'markdown' | 'text' | 'pdf'

export interface ReadFilePreviewInput {
  path: string
  threadId?: string
  workspacePath?: string | null
}

export interface FilePreviewContent {
  path: string
  kind: 'markdown' | 'text' | 'pdf'
  content: string
}

export const MAX_FILE_PREVIEW_BYTES = 25 * 1024 * 1024

export function getFilePreviewKind(path: string): FilePreviewKind | null {
  const extension = path.split(/[\\/]/).pop()?.split('.').pop()?.toLowerCase() ?? ''
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'avif', 'ico'].includes(extension))
    return 'image'
  if (['md', 'markdown', 'mdx'].includes(extension)) return 'markdown'
  if (extension === 'pdf') return 'pdf'
  return [
    'txt',
    'text',
    'log',
    'csv',
    'tsv',
    'json',
    'jsonl',
    'yaml',
    'yml',
    'toml',
    'xml',
    'html',
    'htm',
    'css',
    'scss',
    'js',
    'jsx',
    'ts',
    'tsx',
    'mjs',
    'cjs',
    'py',
    'rs',
    'go',
    'java',
    'c',
    'h',
    'cpp',
    'hpp',
    'sh',
    'bash',
    'zsh',
    'sql',
    'diff',
    'patch',
    'ini',
    'conf'
  ].includes(extension)
    ? 'text'
    : null
}

export function decodePreviewText(bytes: Uint8Array): string {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  if (bytes.some((byte) => byte < 32 && byte !== 9 && byte !== 10 && byte !== 12 && byte !== 13)) {
    throw new Error('This file is not readable text.')
  }
  return text
}
