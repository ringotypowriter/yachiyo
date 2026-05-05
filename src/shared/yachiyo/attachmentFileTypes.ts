export interface AttachmentFileCandidate {
  name: string
  type?: string
  size?: number
}

export interface AcceptedAttachmentFile<T extends AttachmentFileCandidate> {
  file: T
  mediaType: string
}

export type RejectedAttachmentFileReason = 'unsupported-type' | 'too-large' | 'sensitive-file'

export interface RejectedAttachmentFile<T extends AttachmentFileCandidate> {
  file: T
  reason: RejectedAttachmentFileReason
  maxBytes?: number
}

export interface AttachmentFileRejectionRecord {
  filename: string
  reason: RejectedAttachmentFileReason
  maxBytes?: number
}

export interface ClassifiedAttachmentFileSelection<T extends AttachmentFileCandidate> {
  accepted: AcceptedAttachmentFile<T>[]
  rejected: RejectedAttachmentFile<T>[]
}

export const MAX_ATTACHMENT_FILE_BYTES = 25 * 1024 * 1024

export const ACCEPTED_ATTACHMENT_MEDIA_TYPES = [
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-excel',
  'application/graphql',
  'application/javascript',
  'application/json',
  'application/jsonc',
  'application/ld+json',
  'application/sql',
  'application/x-ndjson',
  'application/x-sh',
  'application/x-toml',
  'application/yaml',
  'application/toml',
  'application/xml',
  'text/css',
  'text/graphql',
  'text/html',
  'text/javascript',
  'text/plain',
  'text/csv',
  'text/markdown',
  'text/tab-separated-values',
  'text/typescript',
  'text/xml',
  'text/yaml',
  'text/x-go',
  'text/x-java-source',
  'text/x-python',
  'text/x-ruby',
  'text/x-rust',
  'text/x-shellscript',
  'text/x-sql',
  'text/x-yaml',
  'text/x-toml'
]

const ATTACHMENT_MEDIA_TYPE_BY_EXTENSION: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.doc': 'application/msword',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.xls': 'application/vnd.ms-excel',
  '.txt': 'text/plain',
  '.text': 'text/plain',
  '.log': 'text/plain',
  '.lock': 'text/plain',
  '.csv': 'text/csv',
  '.tsv': 'text/tab-separated-values',
  '.md': 'text/markdown',
  '.markdown': 'text/markdown',
  '.html': 'text/html',
  '.htm': 'text/html',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.jsx': 'text/javascript',
  '.mjs': 'text/javascript',
  '.cjs': 'text/javascript',
  '.ts': 'text/typescript',
  '.tsx': 'text/typescript',
  '.mts': 'text/typescript',
  '.cts': 'text/typescript',
  '.json': 'application/json',
  '.jsonc': 'application/jsonc',
  '.jsonl': 'application/x-ndjson',
  '.ndjson': 'application/x-ndjson',
  '.geojson': 'application/geo+json',
  '.webmanifest': 'application/manifest+json',
  '.yaml': 'application/yaml',
  '.yml': 'application/yaml',
  '.toml': 'application/toml',
  '.xml': 'application/xml',
  '.py': 'text/x-python',
  '.rb': 'text/x-ruby',
  '.go': 'text/x-go',
  '.rs': 'text/x-rust',
  '.java': 'text/x-java-source',
  '.kt': 'text/plain',
  '.kts': 'text/plain',
  '.swift': 'text/plain',
  '.c': 'text/plain',
  '.h': 'text/plain',
  '.cpp': 'text/plain',
  '.cc': 'text/plain',
  '.cxx': 'text/plain',
  '.hpp': 'text/plain',
  '.cs': 'text/plain',
  '.php': 'text/plain',
  '.sh': 'text/x-shellscript',
  '.bash': 'text/x-shellscript',
  '.zsh': 'text/x-shellscript',
  '.fish': 'text/x-shellscript',
  '.ps1': 'text/plain',
  '.sql': 'text/x-sql',
  '.graphql': 'text/graphql',
  '.gql': 'text/graphql',
  '.proto': 'text/plain',
  '.ini': 'text/plain',
  '.conf': 'text/plain',
  '.config': 'text/plain',
  '.properties': 'text/plain'
}

const ATTACHMENT_MEDIA_TYPE_BY_BASENAME: Record<string, string> = {
  '.dockerignore': 'text/plain',
  '.editorconfig': 'text/plain',
  '.gitattributes': 'text/plain',
  '.gitignore': 'text/plain',
  dockerfile: 'text/plain',
  makefile: 'text/plain'
}

export const ACCEPTED_ATTACHMENT_FILE_EXTENSIONS = Object.keys(ATTACHMENT_MEDIA_TYPE_BY_EXTENSION)

const ACCEPTED_ATTACHMENT_MEDIA_TYPE_SET = new Set(ACCEPTED_ATTACHMENT_MEDIA_TYPES)

function normalizeMediaType(value: string | undefined): string {
  if (!value) {
    return ''
  }

  const [base] = value.trim().toLowerCase().split(';')
  return base ?? ''
}

function isJsonDerivedMediaType(mediaType: string): boolean {
  return (
    mediaType === 'application/json' ||
    (mediaType.startsWith('application/') && mediaType.endsWith('+json'))
  )
}

function isXmlDerivedMediaType(mediaType: string): boolean {
  return (
    mediaType === 'application/xml' ||
    (mediaType.startsWith('application/') && mediaType.endsWith('+xml'))
  )
}

function isAcceptedAttachmentMediaType(mediaType: string): boolean {
  return (
    mediaType.startsWith('text/') ||
    isJsonDerivedMediaType(mediaType) ||
    isXmlDerivedMediaType(mediaType) ||
    ACCEPTED_ATTACHMENT_MEDIA_TYPE_SET.has(mediaType)
  )
}

function getLowercaseBasename(filename: string): string {
  const trimmed = filename.trim().toLowerCase()
  const slashIndex = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  return trimmed.slice(slashIndex + 1)
}

function getLowercaseExtension(filename: string): string {
  const basename = getLowercaseBasename(filename)
  const dotIndex = basename.lastIndexOf('.')

  return dotIndex > 0 ? basename.slice(dotIndex) : ''
}

function isSensitiveEnvFile(basename: string): boolean {
  if (basename === '.env' || basename === '.envrc') {
    return true
  }

  if (!basename.startsWith('.env.')) {
    return false
  }

  const suffix = basename.slice('.env.'.length)
  return !['example', 'sample', 'template', 'dist'].some(
    (allowed) => suffix === allowed || suffix.endsWith(`.${allowed}`)
  )
}

function isSensitiveAttachmentFilename(filename: string): boolean {
  const basename = getLowercaseBasename(filename)
  if (isSensitiveEnvFile(basename)) {
    return true
  }

  if (basename === '.npmrc' || basename === '.pypirc' || basename === '.netrc') {
    return true
  }

  if (
    basename === 'id_rsa' ||
    basename === 'id_dsa' ||
    basename === 'id_ecdsa' ||
    basename === 'id_ed25519'
  ) {
    return true
  }

  return ['.pem', '.key', '.p12', '.pfx'].includes(getLowercaseExtension(filename))
}

export function resolveAcceptedAttachmentMediaType(input: AttachmentFileCandidate): string | null {
  const mediaType = normalizeMediaType(input.type)
  if (mediaType && isAcceptedAttachmentMediaType(mediaType)) {
    return mediaType
  }

  const basename = getLowercaseBasename(input.name)
  const basenameMediaType = ATTACHMENT_MEDIA_TYPE_BY_BASENAME[basename]
  if (basenameMediaType) {
    return basenameMediaType
  }

  const extension = getLowercaseExtension(input.name)
  return ATTACHMENT_MEDIA_TYPE_BY_EXTENSION[extension] ?? null
}

export function classifyAttachmentFileSelection<T extends AttachmentFileCandidate>(
  files: T[],
  maxBytes = MAX_ATTACHMENT_FILE_BYTES
): ClassifiedAttachmentFileSelection<T> {
  const accepted: AcceptedAttachmentFile<T>[] = []
  const rejected: RejectedAttachmentFile<T>[] = []

  for (const file of files) {
    if (isSensitiveAttachmentFilename(file.name)) {
      rejected.push({ file, reason: 'sensitive-file' })
      continue
    }

    if (typeof file.size === 'number' && file.size > maxBytes) {
      rejected.push({ file, reason: 'too-large', maxBytes })
      continue
    }

    const mediaType = resolveAcceptedAttachmentMediaType(file)
    if (mediaType) {
      accepted.push({ file, mediaType })
      continue
    }

    rejected.push({ file, reason: 'unsupported-type' })
  }

  return { accepted, rejected }
}

export function toAttachmentFileRejectionRecords<T extends AttachmentFileCandidate>(
  rejected: RejectedAttachmentFile<T>[]
): AttachmentFileRejectionRecord[] {
  return rejected.map((entry) => ({
    filename: entry.file.name,
    reason: entry.reason,
    ...(entry.maxBytes === undefined ? {} : { maxBytes: entry.maxBytes })
  }))
}

export function collectAcceptedAttachmentFiles<T extends AttachmentFileCandidate>(
  files: T[]
): AcceptedAttachmentFile<T>[] {
  return classifyAttachmentFileSelection(files).accepted
}
