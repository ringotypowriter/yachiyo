import { execFile } from 'node:child_process'
import { access, constants, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const AGENTS_MD_PRELOAD_THRESHOLD_BYTES = 10 * 1024

export interface GitContext {
  hasGit: boolean
  currentBranch?: string
  mainBranch?: string
  hasAgentsMd?: boolean
  agentsMdContent?: string
}

export async function detectGitContext(workspacePath: string): Promise<GitContext> {
  try {
    await access(join(workspacePath, '.git'), constants.F_OK)
  } catch {
    return { hasGit: false }
  }

  try {
    const [currentResult, mainResult] = await Promise.allSettled([
      execFileAsync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: workspacePath }),
      execFileAsync('git', ['rev-parse', '--abbrev-ref', 'origin/HEAD'], { cwd: workspacePath })
    ])

    const currentBranch =
      currentResult.status === 'fulfilled' ? currentResult.value.stdout.trim() : undefined
    const rawMain = mainResult.status === 'fulfilled' ? mainResult.value.stdout.trim() : undefined
    const mainBranch = rawMain?.replace(/^origin\//, '') ?? 'main'

    let hasAgentsMd = false
    let agentsMdContent: string | undefined
    try {
      const agentsMdPath = join(workspacePath, 'AGENTS.md')
      const stats = await stat(agentsMdPath)
      hasAgentsMd = true
      if (stats.size <= AGENTS_MD_PRELOAD_THRESHOLD_BYTES) {
        agentsMdContent = await readFile(agentsMdPath, 'utf8')
      }
    } catch {
      // file absent
    }

    return { hasGit: true, currentBranch, mainBranch, hasAgentsMd, agentsMdContent }
  } catch {
    return { hasGit: true }
  }
}
