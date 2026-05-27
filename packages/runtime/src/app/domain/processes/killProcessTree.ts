import { spawnSync } from 'node:child_process'

export interface KillProcessTreeResult {
  /** True when at least one SIGKILL was delivered (process group, a descendant, or the root). */
  delivered: boolean
  /** Descendant pids that were targeted individually, for diagnostics. */
  descendants: number[]
}

/**
 * Kill a process subtree rooted at `rootPid`.
 *
 * The naive `kill(-pid)` only reaps processes still in the root's process group.
 * A detached grandchild (e.g. a WebSocket daemon spawned with `setsid` or
 * node's `detached: true`) lives in a new session and survives that signal.
 *
 * This helper snapshots the ppid tree via `ps` *before* killing — once the root
 * dies its children get reparented to PID 1 and the walk breaks — and then
 * SIGKILLs the process group, each descendant pid, and finally the root.
 */
export function killProcessTree(rootPid: number): KillProcessTreeResult {
  const descendants = listDescendantPidsSync(rootPid)
  let delivered = false

  try {
    process.kill(-rootPid, 'SIGKILL')
    delivered = true
  } catch {
    // ESRCH: no process group with that id (root may not have been a leader
    // or everything already exited). Continue to the per-pid pass.
  }

  for (const pid of descendants) {
    try {
      process.kill(pid, 'SIGKILL')
      delivered = true
    } catch {
      // ESRCH: already reaped (likely taken out by the group kill above).
    }
  }

  try {
    process.kill(rootPid, 'SIGKILL')
    delivered = true
  } catch {
    // ESRCH: root already gone.
  }

  return { delivered, descendants }
}

function listDescendantPidsSync(rootPid: number): number[] {
  const result = spawnSync('/bin/ps', ['-Ao', 'pid=,ppid='], {
    encoding: 'utf8',
    timeout: 2000,
    maxBuffer: 4 * 1024 * 1024
  })
  if (result.status !== 0 || typeof result.stdout !== 'string') {
    return []
  }
  return collectDescendants(rootPid, parsePsPairs(result.stdout))
}

export function parsePsPairs(stdout: string): Array<[number, number]> {
  const pairs: Array<[number, number]> = []
  for (const raw of stdout.split('\n')) {
    const line = raw.trim()
    if (!line) continue
    const parts = line.split(/\s+/)
    if (parts.length < 2) continue
    const pid = Number(parts[0])
    const ppid = Number(parts[1])
    if (!Number.isInteger(pid) || !Number.isInteger(ppid)) continue
    pairs.push([pid, ppid])
  }
  return pairs
}

export function collectDescendants(
  rootPid: number,
  pairs: ReadonlyArray<readonly [number, number]>
): number[] {
  const childrenByParent = new Map<number, number[]>()
  for (const [pid, ppid] of pairs) {
    const list = childrenByParent.get(ppid)
    if (list) list.push(pid)
    else childrenByParent.set(ppid, [pid])
  }

  const out: number[] = []
  const queue: number[] = [rootPid]
  const seen = new Set<number>([rootPid])
  while (queue.length > 0) {
    const current = queue.shift() as number
    const kids = childrenByParent.get(current)
    if (!kids) continue
    for (const kid of kids) {
      if (seen.has(kid)) continue
      seen.add(kid)
      out.push(kid)
      queue.push(kid)
    }
  }
  return out
}
