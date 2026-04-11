import { readdir, readFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { homedir } from 'node:os'

import type { SkillCatalogEntry, SkillOrigin } from '../../../../shared/yachiyo/protocol.ts'
import { resolveYachiyoDataDir } from '../../config/paths.ts'

export const SKILL_FILE_NAME = 'SKILL.md'

const SKILL_SOURCE_DIR_NAMES = ['.yachiyo', '.codex', '.agents', '.claude'] as const

/**
 * Hint recorded on each discovery root. For most roots the origin is known at
 * root-build time; for the Yachiyo home root we defer the decision to the
 * individual skill path because bundled-core and user-custom live side by side
 * under `~/.yachiyo/skills/core/` and `~/.yachiyo/skills/custom/` respectively.
 */
type SkillOriginHint = SkillOrigin | 'yachiyo-home'

export interface SkillDiscoveryRoot {
  scope: 'workspace' | 'home'
  rootPath: string
  autoEnabled?: boolean
  originHint: SkillOriginHint
}

export interface DiscoveredSkill extends SkillCatalogEntry {
  scope: SkillDiscoveryRoot['scope']
  rootPath: string
}

export interface IsBundledSkillPathOptions {
  /**
   * Force case-insensitive comparison. Defaults to `process.platform === 'win32'`
   * because Windows filesystems are case-insensitive but preserve case, so two
   * paths that address the same directory may differ only in casing (e.g.
   * `C:\Users\...` vs `c:\users\...`). POSIX filesystems are case-sensitive by
   * convention, so we leave comparisons exact there. Tests can override
   * explicitly to exercise either behavior from any host OS.
   */
  caseInsensitive?: boolean
}

/**
 * Cross-platform check for whether a skill directory is a bundled core skill.
 * Bundled skills live exclusively under the Yachiyo home's
 * `<yachiyoSkillsDir>/core/` directory — NOT any path that happens to contain
 * the segment `.yachiyo/skills/core/`. A workspace repo can legitimately have
 * its own `<repo>/.yachiyo/skills/core/foo` skill (workspace-scope), and that
 * must not be flagged as read-only bundled content.
 *
 * The check is a proper absolute-path prefix match against the specific
 * Yachiyo home's core directory. Both inputs are normalized to forward
 * slashes so the same check works on POSIX and Windows, and the home dir's
 * trailing separators are trimmed so the prefix math is unambiguous. On
 * Windows (or whenever `caseInsensitive: true` is passed explicitly) the
 * comparison is also lowercased so a discovered directoryPath whose drive
 * letter or user dir differs in case from YACHIYO_HOME still matches.
 *
 * This is the single source of truth for "is this skill read-only?" and is
 * re-used by `dumpThread()` (via `enrichSkillsReadDetails`) to tag
 * `skillsRead` tool call details for the self-review pass.
 */
export function isBundledSkillPath(
  directoryPath: string,
  yachiyoSkillsDir: string,
  options: IsBundledSkillPathOptions = {}
): boolean {
  const caseInsensitive = options.caseInsensitive ?? process.platform === 'win32'
  const normalize = (p: string): string => {
    const slashed = p.replace(/\\/g, '/').replace(/\/+$/, '')
    return caseInsensitive ? slashed.toLowerCase() : slashed
  }
  const coreRoot = `${normalize(yachiyoSkillsDir)}/core`
  const target = normalize(directoryPath)
  return target === coreRoot || target.startsWith(`${coreRoot}/`)
}

/**
 * Resolve a skill's final origin from its discovery root's hint. For the
 * Yachiyo home root we look at whether the skill lives under `core/` — those
 * are bundled skills written by the app's core-skill extractor and must stay
 * read-only. Everything else under the Yachiyo home root is user-owned custom
 * content.
 */
function resolveSkillOrigin(
  originHint: SkillOriginHint,
  rootPath: string,
  directoryPath: string
): SkillOrigin {
  if (originHint !== 'yachiyo-home') return originHint
  // For yachiyo-home roots, `rootPath` IS the Yachiyo home's skills dir,
  // because that's how buildSkillDiscoveryRoots() constructs it.
  return isBundledSkillPath(directoryPath, rootPath) ? 'bundled' : 'custom'
}

interface ParsedFrontmatter {
  body: string
  data: Record<string, string>
}

function normalizeString(value: string | undefined): string | undefined {
  const normalized = value?.trim()
  return normalized ? normalized : undefined
}

function unquoteFrontmatterValue(value: string): string {
  const trimmed = value.trim()
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1).trim()
  }

  return trimmed
}

function parseFrontmatter(content: string): ParsedFrontmatter {
  if (!content.startsWith('---\n')) {
    return {
      body: content,
      data: {}
    }
  }

  const endIndex = content.indexOf('\n---\n', 4)
  if (endIndex < 0) {
    return {
      body: content,
      data: {}
    }
  }

  const data: Record<string, string> = {}
  const rawFrontmatter = content.slice(4, endIndex)

  for (const rawLine of rawFrontmatter.split('\n')) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) {
      continue
    }

    const separatorIndex = line.indexOf(':')
    if (separatorIndex <= 0) {
      continue
    }

    const key = line.slice(0, separatorIndex).trim()
    const value = unquoteFrontmatterValue(line.slice(separatorIndex + 1))
    if (!key || !value) {
      continue
    }

    data[key] = value
  }

  return {
    body: content.slice(endIndex + '\n---\n'.length),
    data
  }
}

function extractHeadingName(body: string): string | undefined {
  for (const rawLine of body.split(/\r?\n/u)) {
    const line = rawLine.trim()
    if (!line) {
      continue
    }

    const headingMatch = /^#\s+(.+)$/u.exec(line)
    if (headingMatch) {
      return normalizeString(headingMatch[1])
    }

    return undefined
  }

  return undefined
}

function extractBodySummary(body: string): string | undefined {
  const paragraphs = body
    .split(/\n\s*\n/u)
    .map((paragraph) =>
      paragraph
        .split(/\r?\n/u)
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith('#'))
        .join(' ')
        .trim()
    )
    .filter(Boolean)

  return normalizeString(paragraphs[0])
}

async function collectSkillFiles(rootPath: string): Promise<string[]> {
  let entries

  try {
    entries = await readdir(rootPath, { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return []
    }

    throw error
  }

  const discovered: string[] = []

  for (const entry of entries) {
    const entryPath = join(rootPath, entry.name)

    if (entry.isDirectory()) {
      discovered.push(...(await collectSkillFiles(entryPath)))
      continue
    }

    if (entry.isFile() && entry.name === SKILL_FILE_NAME) {
      discovered.push(entryPath)
    }
  }

  return discovered
}

async function readSkillRecord(input: {
  scope: SkillDiscoveryRoot['scope']
  rootPath: string
  skillFilePath: string
  autoEnabled?: boolean
  originHint: SkillOriginHint
}): Promise<DiscoveredSkill | null> {
  let content: string

  try {
    content = await readFile(input.skillFilePath, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null
    }

    throw error
  }

  const skillFilePath = resolve(input.skillFilePath)
  const directoryPath = resolve(dirname(skillFilePath))
  const { body, data } = parseFrontmatter(content)
  const name =
    normalizeString(data['name']) ??
    normalizeString(data['title']) ??
    extractHeadingName(body) ??
    normalizeString(basename(directoryPath))

  if (!name) {
    return null
  }

  const rootPath = resolve(input.rootPath)
  const origin = resolveSkillOrigin(input.originHint, rootPath, directoryPath)

  return {
    name,
    description:
      normalizeString(data['description']) ??
      normalizeString(data['summary']) ??
      extractBodySummary(body),
    directoryPath,
    skillFilePath,
    ...(input.autoEnabled ? { autoEnabled: true } : {}),
    origin,
    scope: input.scope,
    rootPath
  }
}

export function buildSkillDiscoveryRoots(workspacePaths: string[] = []): SkillDiscoveryRoot[] {
  const roots: SkillDiscoveryRoot[] = []
  const seen = new Set<string>()
  const normalizedWorkspacePaths = [
    ...new Set(
      workspacePaths
        .map((path) => path.trim())
        .filter(Boolean)
        .map((path) => resolve(path))
    )
  ]

  for (const workspacePath of normalizedWorkspacePaths) {
    for (const dirName of SKILL_SOURCE_DIR_NAMES) {
      const rootPath = resolve(join(workspacePath, dirName, 'skills'))
      if (seen.has(rootPath)) {
        continue
      }
      seen.add(rootPath)
      roots.push({
        scope: 'workspace',
        rootPath,
        autoEnabled: dirName === '.yachiyo',
        originHint: dirName === '.yachiyo' ? 'workspace' : 'external'
      })
    }
  }

  const yachiyoHomeRoot = resolve(join(resolveYachiyoDataDir(), 'skills'))
  const otherHomeRoots = SKILL_SOURCE_DIR_NAMES.filter((dirName) => dirName !== '.yachiyo').map(
    (dirName) => resolve(join(homedir(), dirName, 'skills'))
  )

  if (!seen.has(yachiyoHomeRoot)) {
    seen.add(yachiyoHomeRoot)
    roots.push({
      scope: 'home',
      rootPath: yachiyoHomeRoot,
      autoEnabled: true,
      originHint: 'yachiyo-home'
    })
  }

  for (const rootPath of otherHomeRoots) {
    if (seen.has(rootPath)) {
      continue
    }
    seen.add(rootPath)
    roots.push({ scope: 'home', rootPath, originHint: 'external' })
  }

  return roots
}

export async function discoverSkills(workspacePaths: string[] = []): Promise<DiscoveredSkill[]> {
  const discovered: DiscoveredSkill[] = []

  for (const root of buildSkillDiscoveryRoots(workspacePaths)) {
    let skillFilePaths: string[]

    try {
      skillFilePaths = await collectSkillFiles(root.rootPath)
    } catch (error) {
      console.warn('[yachiyo][skills] failed to scan root', {
        error: error instanceof Error ? error.message : String(error),
        rootPath: root.rootPath
      })
      continue
    }

    for (const skillFilePath of skillFilePaths) {
      try {
        const skill = await readSkillRecord({
          scope: root.scope,
          rootPath: root.rootPath,
          skillFilePath,
          autoEnabled: root.autoEnabled,
          originHint: root.originHint
        })

        if (skill) {
          discovered.push(skill)
        }
      } catch (error) {
        console.warn('[yachiyo][skills] failed to read skill', {
          error: error instanceof Error ? error.message : String(error),
          skillFilePath
        })
      }
    }
  }

  return discovered
}
