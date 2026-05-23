import type {
  SearchFileDiscoveryBackend,
  SearchGrepBackend,
  SkillOrigin,
  WebReadContentFormat,
  WebReadExtractor,
  WebReadFailureCode,
  WebSearchFailureCode
} from '../protocol.ts'

export interface ReadToolCallDetails {
  path: string
  startLine: number
  endLine: number
  totalLines: number
  totalBytes: number
  truncated: boolean
  nextOffset?: number
  remainingLines?: number
  /** Set for image reads; contains the IANA media type e.g. "image/png". */
  mediaType?: string
  /** Set for PDF reads; total number of pages in the document. */
  totalPages?: number
  /** Whether the result was served from extraction cache. */
  cached?: boolean
}

export interface WriteToolCallDetails {
  path: string
  bytesWritten: number
  created: boolean
  overwritten: boolean
  /** Truncated preview of the written content (first ~50 lines). */
  contentPreview?: string
}

export interface EditToolCallDetails {
  path: string
  mode: 'inline' | 'range' | 'batch'
  replacements: number
  diff?: string
  firstChangedLine?: number
}

export interface BashToolCallDetails {
  command: string
  cwd: string
  exitCode?: number
  stdout: string
  stderr: string
  truncated?: boolean
  timedOut?: boolean
  blocked?: boolean
  outputFilePath?: string
  background?: boolean
  taskId?: string
  logPath?: string
  /** Foreground command exceeded its timeout and was adopted as a background task. */
  liftedAfterTimeout?: boolean
}

export interface JsReplToolCallDetails {
  code: string
  result?: string
  consoleOutput?: string
  error?: string
  timedOut?: boolean
  contextReset?: boolean
  cwd?: string
}

export interface GrepToolCallMatch {
  path: string
  line: number
  text: string
  contextBefore?: string[]
  contextAfter?: string[]
}

export interface GrepToolCallDetails {
  backend: SearchGrepBackend
  pattern: string
  path: string
  resultCount: number
  truncated: boolean
  matches: GrepToolCallMatch[]
}

export interface GlobToolCallDetails {
  backend: SearchFileDiscoveryBackend
  pattern: string
  path: string
  resultCount: number
  truncated: boolean
  matches: string[]
}

export interface WebReadToolCallDetails {
  requestedUrl: string
  finalUrl?: string
  httpStatus?: number
  contentType?: string
  extractor: WebReadExtractor
  title?: string
  author?: string
  siteName?: string
  publishedTime?: string
  description?: string
  content: string
  contentFormat: WebReadContentFormat
  contentChars: number
  truncated: boolean
  originalContentChars?: number
  savedFileName?: string
  savedFilePath?: string
  savedBytes?: number
  failureCode?: WebReadFailureCode
}

export interface WebSearchResultItem {
  title: string
  url: string
  snippet?: string
  rank: number
}

export interface WebSearchToolCallDetails {
  provider: string
  query: string
  searchUrl?: string
  finalUrl?: string
  results: WebSearchResultItem[]
  resultCount: number
  failureCode?: WebSearchFailureCode
}

export interface SkillsReadRecord {
  name: string
  directoryPath: string
  skillFilePath: string
  description?: string
  content?: string
  /**
   * Skill provenance, frozen at tool execution time from the catalog entry
   * that resolved this call. Populated on every new `skillsRead` invocation
   * since the origin-freeze change; historical rows written before that may
   * lack the field and fall back to `enrichSkillsReadDetails()` in
   * `dumpThread()` for a best-effort recomputation. Downstream consumers
   * (notably the self-review schedule) should trust this field as the
   * authoritative signal for "was this skill bundled or writable at the
   * time the reviewed run invoked it?".
   */
  origin?: SkillOrigin
}

export interface SkillsReadToolCallDetails {
  requestedNames: string[]
  resolvedCount: number
  skills: SkillsReadRecord[]
  missingNames?: string[]
}

export interface AskUserToolCallDetails {
  kind: 'askUser'
  question: string
  choices?: string[]
  answer?: string
}

export interface ApplyPatchFileOperation {
  path: string
  operation: 'add' | 'delete' | 'update' | 'move'
  movePath?: string
  diff?: string
}

export interface ApplyPatchToolCallDetails {
  operations: ApplyPatchFileOperation[]
}

export interface UseBrowserToolCallDetails {
  kind: 'useBrowser'
  action:
    | 'open'
    | 'close'
    | 'getUrl'
    | 'getTitle'
    | 'loadUrl'
    | 'wait'
    | 'snapshot'
    | 'click'
    | 'fill'
    | 'type'
    | 'select'
    | 'check'
    | 'press'
    | 'screenshot'
    | 'pdf'
  session: string
  url?: string
  ref?: string
  key?: string
  value?: string
  checked?: boolean
  timeoutMs?: number
  savedFileName?: string
  savedFilePath?: string
  bytesWritten?: number
  refCount?: number
  finalUrl?: string
  title?: string
}

export type ToolCallDetailsSnapshot =
  | ReadToolCallDetails
  | WriteToolCallDetails
  | EditToolCallDetails
  | BashToolCallDetails
  | JsReplToolCallDetails
  | GrepToolCallDetails
  | GlobToolCallDetails
  | WebReadToolCallDetails
  | UseBrowserToolCallDetails
  | WebSearchToolCallDetails
  | SkillsReadToolCallDetails
  | AskUserToolCallDetails
  | ApplyPatchToolCallDetails
