import { app } from 'electron'
import { is } from '@electron-toolkit/utils'
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { resolveYachiyoDataDir, resolveYachiyoSettingsPath } from './yachiyo-server/config/paths.ts'
import { createSettingsStore } from './yachiyo-server/settings/settingsStore.ts'

const CORE_SKILLS_SUBDIR = join('skills', 'core')
const MANIFEST_FILE = '.manifest.json'

interface CoreSkillsManifest {
  appVersion: string
  registeredSkills: string[]
}

function resolveBundledCoreSkillsPath(): string {
  // Dev: project root / resources / core-skills
  // Prod: bundled alongside main process output (out/main/core-skills)
  return is.dev ? join(app.getAppPath(), 'resources', 'core-skills') : join(__dirname, 'core-skills')
}

function resolveCoreSkillsTargetPath(): string {
  return join(resolveYachiyoDataDir(), CORE_SKILLS_SUBDIR)
}

function resolveManifestPath(targetPath: string): string {
  return join(targetPath, MANIFEST_FILE)
}

function readManifest(targetPath: string): CoreSkillsManifest | null {
  const manifestPath = resolveManifestPath(targetPath)
  if (!existsSync(manifestPath)) return null
  try {
    const raw = readFileSync(manifestPath, 'utf8')
    return JSON.parse(raw) as CoreSkillsManifest
  } catch {
    return null
  }
}

function writeManifest(targetPath: string, manifest: CoreSkillsManifest): void {
  writeFileSync(resolveManifestPath(targetPath), JSON.stringify(manifest, null, 2) + '\n', 'utf8')
}

/**
 * Read the `name` field from a SKILL.md file's YAML frontmatter.
 * Returns null if not found or unreadable.
 */
function parseSkillName(skillFilePath: string): string | null {
  try {
    const content = readFileSync(skillFilePath, 'utf8')
    if (!content.startsWith('---\n')) return null
    const end = content.indexOf('\n---\n', 4)
    if (end < 0) return null
    for (const line of content.slice(4, end).split('\n')) {
      const match = /^name\s*:\s*(.+)$/u.exec(line.trim())
      if (match) {
        return match[1].replace(/^["']|["']$/gu, '').trim() || null
      }
    }
  } catch {
    // unreadable — fall through
  }
  return null
}

/**
 * Scan the bundled core-skills directory for immediate subdirectories that
 * contain a SKILL.md. Returns their parsed skill names (falling back to the
 * directory name when frontmatter is absent).
 */
function collectBundledSkillNames(bundledPath: string): string[] {
  const names: string[] = []
  try {
    const entries = readdirSync(bundledPath, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const skillFile = join(bundledPath, entry.name, 'SKILL.md')
      if (!existsSync(skillFile)) continue
      names.push(parseSkillName(skillFile) ?? entry.name)
    }
  } catch {
    // bundledPath unreadable — caller handles the empty result
  }
  return names
}

/**
 * Merge newSkillNames into the `skills.enabled` list in config.toml.
 * Existing entries are preserved; this never removes skills.
 */
function ensureCoreSkillsEnabled(newSkillNames: string[]): void {
  if (newSkillNames.length === 0) return
  const store = createSettingsStore(resolveYachiyoSettingsPath())
  const config = store.read()
  const enabled = new Set(config.skills?.enabled ?? [])
  let changed = false
  for (const name of newSkillNames) {
    if (!enabled.has(name)) {
      enabled.add(name)
      changed = true
    }
  }
  if (changed) {
    store.write({ ...config, skills: { enabled: [...enabled] } })
  }
}

function runSetup(): void {
  const bundledPath = resolveBundledCoreSkillsPath()

  if (!existsSync(bundledPath)) {
    console.warn('[core-skills] Bundled directory not found:', bundledPath)
    return
  }

  const appVersion = app.getVersion()
  const targetPath = resolveCoreSkillsTargetPath()
  const manifest = readManifest(targetPath)

  if (manifest?.appVersion === appVersion) {
    // Already up to date for this version — nothing to do.
    return
  }

  // Extract: copy bundled core-skills → ~/.yachiyo/skills/core/
  // (never touches ~/.yachiyo/skills/custom/ or any sibling directory)
  mkdirSync(targetPath, { recursive: true })
  cpSync(bundledPath, targetPath, { recursive: true })

  const allSkillNames = collectBundledSkillNames(bundledPath)
  const previouslyRegistered = new Set(manifest?.registeredSkills ?? [])
  const newSkillNames = allSkillNames.filter((name) => !previouslyRegistered.has(name))

  // Auto-enable skills that have never been registered before.
  // Skills the user explicitly disabled (removed from enabled list) are not re-added.
  ensureCoreSkillsEnabled(newSkillNames)

  writeManifest(targetPath, { appVersion, registeredSkills: allSkillNames })

  console.log(
    `[core-skills] Extracted ${allSkillNames.length} skill(s) to ${targetPath}` +
      (newSkillNames.length > 0 ? ` (${newSkillNames.length} newly enabled: ${newSkillNames.join(', ')})` : '')
  )
}

/**
 * Copy bundled core skills to ~/.yachiyo/skills/core/ if the app version has
 * changed since the last extraction. Newly added core skills are automatically
 * enabled in config.toml. Runs in the background and never blocks UI rendering.
 */
export function setupCoreSkills(): void {
  // Defer to after the current synchronous startup sequence so that window
  // creation and initial rendering are not delayed.
  setImmediate(() => {
    try {
      runSetup()
    } catch (error) {
      console.error('[core-skills] Setup failed:', error)
    }
  })
}
