import { spawn } from 'node:child_process'
import { accessSync, constants } from 'node:fs'
import { delimiter, join } from 'node:path'

import type { SettingsConfig } from '../../../../shared/yachiyo/protocol.ts'
import { DEFAULT_MEMORY_BASE_URL } from '../../../../shared/yachiyo/protocol.ts'
import type {
  CreateThreadInput,
  DistillThreadInput,
  MemoryCandidate,
  MemorySearchResult,
  MemoryUnitType,
  ThreadAwareMemoryProvider
} from './memoryService.ts'

interface NowledgeMemSearchResponseItem {
  id?: unknown
  title?: unknown
  content?: unknown
  text?: unknown
  snippet?: unknown
  score?: unknown
  confidence?: unknown
  source_thread?: unknown
  sourceThreadId?: unknown
  labels?: unknown
  unit_type?: unknown
  unitType?: unknown
  importance?: unknown
}

interface NowledgeMemCliResponse {
  error?: unknown
  message?: unknown
  detail?: unknown
  memories?: unknown
}

export interface RunNowledgeMemCommandInput {
  args: string[]
  env?: NodeJS.ProcessEnv
  signal?: AbortSignal
}

export interface RunNowledgeMemCommandResult {
  exitCode: number
  stderr: string
  stdout: string
}

export interface NowledgeMemProviderDeps {
  runCommand?: (input: RunNowledgeMemCommandInput) => Promise<RunNowledgeMemCommandResult>
}

const COMMON_CLI_PATH_SEGMENTS = ['/opt/homebrew/bin', '/usr/local/bin', '/opt/local/bin']

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/u, '')
}

function withAugmentedPath(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const homeDir = env.HOME?.trim()
  const additionalSegments = [
    ...COMMON_CLI_PATH_SEGMENTS,
    ...(homeDir ? [join(homeDir, '.local', 'bin'), join(homeDir, 'bin')] : [])
  ]
  const existingSegments = (env.PATH ?? '')
    .split(delimiter)
    .map((segment) => segment.trim())
    .filter(Boolean)

  const pathSegments = [...existingSegments]
  for (const segment of additionalSegments) {
    if (!pathSegments.includes(segment)) {
      pathSegments.push(segment)
    }
  }

  return {
    ...env,
    PATH: pathSegments.join(delimiter)
  }
}

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

function resolveCommandOnPath(command: string, env: NodeJS.ProcessEnv): string | undefined {
  const pathValue = env.PATH
  if (!pathValue) {
    return undefined
  }

  for (const segment of pathValue.split(delimiter)) {
    if (!segment) {
      continue
    }

    const candidatePath = join(segment, command)
    if (isExecutable(candidatePath)) {
      return candidatePath
    }
  }

  return undefined
}

function normalizeBaseUrl(config: SettingsConfig): string {
  return trimTrailingSlash(config.memory?.baseUrl?.trim() || DEFAULT_MEMORY_BASE_URL)
}

function normalizeSearchResult(item: NowledgeMemSearchResponseItem): MemorySearchResult | null {
  const contentSource =
    typeof item.content === 'string'
      ? item.content
      : typeof item.text === 'string'
        ? item.text
        : typeof item.snippet === 'string'
          ? item.snippet
          : ''
  const content = contentSource.trim()
  if (!content) {
    return null
  }

  const sourceThreadId =
    typeof item.sourceThreadId === 'string'
      ? item.sourceThreadId
      : typeof item.source_thread === 'string'
        ? item.source_thread
        : undefined

  const score =
    typeof item.score === 'number'
      ? item.score
      : typeof item.confidence === 'number'
        ? item.confidence
        : undefined

  const labels = Array.isArray(item.labels)
    ? item.labels.filter((label): label is string => typeof label === 'string')
    : undefined
  const unitType = normalizeUnitType(item.unitType ?? item.unit_type)
  const importance = typeof item.importance === 'number' ? item.importance : undefined

  return {
    id: typeof item.id === 'string' ? item.id : normalizeResultId(item),
    ...(typeof item.title === 'string' ? { title: item.title.trim() } : {}),
    content,
    ...(score !== undefined ? { score } : {}),
    ...(sourceThreadId ? { sourceThreadId } : {}),
    ...(labels?.length ? { labels } : {}),
    ...(importance !== undefined ? { importance } : {}),
    ...(unitType ? { unitType } : {})
  }
}

function normalizeUnitType(value: unknown): MemoryUnitType | undefined {
  switch (value) {
    case 'fact':
    case 'preference':
    case 'decision':
    case 'plan':
    case 'procedure':
    case 'learning':
    case 'context':
    case 'event':
      return value
    default:
      return undefined
  }
}

function buildTopicLabel(topic: string): string {
  return `topic:${topic}`
}

function normalizeResultId(item: NowledgeMemSearchResponseItem): string {
  return [
    typeof item.title === 'string' ? item.title : '',
    typeof item.content === 'string' ? item.content : typeof item.text === 'string' ? item.text : ''
  ]
    .join(':')
    .slice(0, 120)
}

function parseJsonPayload(text: string): unknown {
  const trimmed = text.trim()
  if (!trimmed) {
    return null
  }

  try {
    return JSON.parse(trimmed)
  } catch {
    return trimmed
  }
}

function toSearchItems(payload: unknown): NowledgeMemSearchResponseItem[] {
  if (Array.isArray(payload)) {
    return payload as NowledgeMemSearchResponseItem[]
  }

  if (payload && typeof payload === 'object') {
    const record = payload as Record<string, unknown>

    if (Array.isArray(record['results'])) {
      return record['results'] as NowledgeMemSearchResponseItem[]
    }

    if (Array.isArray(record['memories'])) {
      return record['memories'] as NowledgeMemSearchResponseItem[]
    }

    if (Array.isArray(record['items'])) {
      return record['items'] as NowledgeMemSearchResponseItem[]
    }
  }

  return []
}

function stringifyCommandFailureDetail(
  payload: NowledgeMemCliResponse | string | null,
  fallback: string
): string {
  if (typeof payload === 'string') {
    return payload || fallback
  }

  if (payload && typeof payload === 'object') {
    const detail =
      typeof payload.detail === 'string'
        ? payload.detail
        : typeof payload.message === 'string'
          ? payload.message
          : typeof payload.error === 'string'
            ? payload.error
            : ''
    if (detail) {
      return detail
    }
  }

  return fallback
}

async function runNowledgeMemCommand(
  input: RunNowledgeMemCommandInput
): Promise<RunNowledgeMemCommandResult> {
  return await new Promise((resolvePromise, rejectPromise) => {
    const env = withAugmentedPath({
      ...process.env,
      ...input.env
    })
    const executable = resolveCommandOnPath('nmem', env)

    if (!executable) {
      const error = new Error('spawn nmem ENOENT') as Error & { code?: string }
      error.code = 'ENOENT'
      rejectPromise(error)
      return
    }

    const child = spawn(executable, ['--json', ...input.args], {
      env,
      stdio: ['ignore', 'pipe', 'pipe']
    })

    let stdout = ''
    let stderr = ''

    const onAbort = (): void => {
      child.kill('SIGTERM')
    }

    input.signal?.addEventListener('abort', onAbort, { once: true })
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk
    })
    child.once('error', (error) => {
      input.signal?.removeEventListener('abort', onAbort)
      rejectPromise(error)
    })
    child.once('close', (exitCode) => {
      input.signal?.removeEventListener('abort', onAbort)
      resolvePromise({
        exitCode: exitCode ?? 0,
        stdout,
        stderr
      })
    })
  })
}

function parseDistillSavedCount(payload: unknown): number {
  if (!payload || typeof payload !== 'object') {
    return 0
  }

  const record = payload as Record<string, unknown>

  if (typeof record['count'] === 'number') {
    return record['count']
  }

  if (typeof record['memories_created'] === 'number') {
    return record['memories_created']
  }

  if (typeof record['saved'] === 'number') {
    return record['saved']
  }

  if (Array.isArray(record['memories'])) {
    return record['memories'].length
  }

  if (Array.isArray(record['results'])) {
    return record['results'].length
  }

  if (record['skipped'] === true || record['status'] === 'skipped') {
    return 0
  }

  return 0
}

function toCommandEnv(baseUrl: string): NodeJS.ProcessEnv {
  return {
    NMEM_API_URL: baseUrl
  }
}

export function createNowledgeMemProvider(
  config: SettingsConfig,
  deps: NowledgeMemProviderDeps = {}
): ThreadAwareMemoryProvider {
  const runCommand = deps.runCommand ?? runNowledgeMemCommand
  const baseUrl = normalizeBaseUrl(config)
  const env = toCommandEnv(baseUrl)

  return {
    async createMemories(input: {
      items: MemoryCandidate[]
      signal?: AbortSignal
    }): Promise<{ savedCount: number }> {
      let savedCount = 0

      for (const item of input.items) {
        const args = [
          'm',
          'add',
          '--title',
          item.title,
          '--source',
          'Yachiyo',
          '--label',
          buildTopicLabel(item.topic),
          '--unit-type',
          item.unitType,
          ...(item.importance !== undefined ? ['--importance', String(item.importance)] : []),
          item.content
        ]
        const result = await runCommand({
          args,
          env,
          signal: input.signal
        })
        const payload = parseJsonPayload(result.stdout) as NowledgeMemCliResponse | string | null

        if (
          result.exitCode !== 0 ||
          (payload && typeof payload === 'object' && typeof payload.error === 'string')
        ) {
          throw new Error(
            `Nowledge Mem create failed: ${stringifyCommandFailureDetail(
              payload,
              result.stderr.trim() || `exit ${result.exitCode}`
            )}`
          )
        }

        savedCount += 1
      }

      return { savedCount }
    },

    async searchMemories(input: {
      limit: number
      query: string
      label?: string
      signal?: AbortSignal
    }): Promise<MemorySearchResult[]> {
      const result = await runCommand({
        args: [
          'm',
          'search',
          '--limit',
          String(input.limit),
          ...(input.label ? ['--label', input.label] : []),
          input.query
        ],
        env,
        signal: input.signal
      })
      const payload = parseJsonPayload(result.stdout) as NowledgeMemCliResponse | string | null

      if (
        result.exitCode !== 0 ||
        (payload && typeof payload === 'object' && typeof payload.error === 'string')
      ) {
        throw new Error(
          `Nowledge Mem search failed: ${stringifyCommandFailureDetail(
            payload,
            result.stderr.trim() || `exit ${result.exitCode}`
          )}`
        )
      }

      return toSearchItems(payload)
        .map(normalizeSearchResult)
        .filter((item): item is MemorySearchResult => item !== null)
    },

    async updateMemory(input: {
      id: string
      item: MemoryCandidate
      signal?: AbortSignal
    }): Promise<void> {
      const result = await runCommand({
        args: [
          'm',
          'update',
          input.id,
          '--title',
          input.item.title,
          '--content',
          input.item.content,
          ...(input.item.importance !== undefined
            ? ['--importance', String(input.item.importance)]
            : [])
        ],
        env,
        signal: input.signal
      })
      const payload = parseJsonPayload(result.stdout) as NowledgeMemCliResponse | string | null

      if (
        result.exitCode !== 0 ||
        (payload && typeof payload === 'object' && typeof payload.error === 'string')
      ) {
        throw new Error(
          `Nowledge Mem update failed: ${stringifyCommandFailureDetail(
            payload,
            result.stderr.trim() || `exit ${result.exitCode}`
          )}`
        )
      }
    },

    async createThread(input: CreateThreadInput): Promise<void> {
      const messagesJson = JSON.stringify(
        input.messages.map((m) => ({ role: m.role, content: m.content }))
      )
      const result = await runCommand({
        args: [
          't',
          'create',
          '--id',
          input.threadId,
          '-t',
          input.title,
          '-m',
          messagesJson,
          '-s',
          'yachiyo'
        ],
        env,
        signal: input.signal
      })
      const payload = parseJsonPayload(result.stdout) as NowledgeMemCliResponse | string | null

      if (
        result.exitCode !== 0 ||
        (payload && typeof payload === 'object' && typeof payload.error === 'string')
      ) {
        throw new Error(
          `Nowledge Mem thread create failed: ${stringifyCommandFailureDetail(
            payload,
            result.stderr.trim() || `exit ${result.exitCode}`
          )}`
        )
      }
    },

    async distillThread(input: DistillThreadInput): Promise<{ savedCount: number }> {
      const result = await runCommand({
        args: [
          't',
          'distill',
          input.threadId,
          ...(input.triage ? ['--triage'] : [])
        ],
        env,
        signal: input.signal
      })
      const payload = parseJsonPayload(result.stdout) as NowledgeMemCliResponse | string | null

      if (
        result.exitCode !== 0 ||
        (payload && typeof payload === 'object' && typeof payload.error === 'string')
      ) {
        throw new Error(
          `Nowledge Mem thread distill failed: ${stringifyCommandFailureDetail(
            payload,
            result.stderr.trim() || `exit ${result.exitCode}`
          )}`
        )
      }

      return { savedCount: parseDistillSavedCount(payload) }
    }
  }
}
