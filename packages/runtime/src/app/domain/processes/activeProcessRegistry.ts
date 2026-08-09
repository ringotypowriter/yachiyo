import type { ChildProcess } from 'node:child_process'

import {
  forceTerminateChildProcess,
  processTree as defaultProcessTree,
  type ProcessTree
} from './processTree.ts'

export class ActiveProcessRegistry {
  private readonly unregisterByChild = new Map<ChildProcess, () => void>()
  private readonly processTree: ProcessTree

  constructor(processTree: ProcessTree = defaultProcessTree) {
    this.processTree = processTree
  }

  register(child: ChildProcess): () => void {
    const existing = this.unregisterByChild.get(child)
    if (existing) return existing

    const unregister = (): void => {
      if (!this.unregisterByChild.delete(child)) return
      child.removeListener('exit', unregister)
      child.removeListener('close', unregister)
    }

    this.unregisterByChild.set(child, unregister)
    child.once('exit', unregister)
    child.once('close', unregister)
    return unregister
  }

  syncTerminateAll(): void {
    const activeChildren = [...this.unregisterByChild.keys()]
    for (const child of activeChildren) {
      this.unregisterByChild.get(child)?.()
    }

    for (const child of activeChildren) {
      const result = forceTerminateChildProcess(child, this.processTree)
      if (!result.delivered && !result.alreadyExited) {
        console.warn('[yachiyo][active-process-registry] process-tree termination failed', {
          pid: child.pid,
          error: result.error
        })
      }
    }
  }
}

export const activeProcessRegistry = new ActiveProcessRegistry()

export function registerActiveChildProcess(child: ChildProcess): () => void {
  return activeProcessRegistry.register(child)
}

process.on('exit', () => {
  activeProcessRegistry.syncTerminateAll()
})
