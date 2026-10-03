import type { WebContents } from 'electron'

import { buildBrowserAutomationSnapshotScript } from './browserAutomationSnapshotScript.ts'
import type { BrowserAutomationSnapshot } from './browserAutomationToolBackend.ts'

type FrameContext = { frameId: string; sessionId?: string; contextId: number }
type FrameTree = {
  frame: { id: string; securityOrigin?: string }
  childFrames?: FrameTree[]
}
type FrameEntry = { frameId: string; parentId: string; origin?: string; target?: TargetInfo }
type TargetInfo = {
  targetId: string
  type: string
  parentFrameId?: string
  browserContextId?: string
}

export interface BrowserFrameSnapshotCollection {
  frames: Array<FrameContext & { snapshot: BrowserAutomationSnapshot }>
  unavailableFrames: Array<{ frameId: string; reason: string }>
}

const frameSessions = new WeakMap<WebContents, Map<string, string>>()
const MAX_CROSS_ORIGIN_FRAMES = 16
const MAX_FRAME_DISCOVERY = 256

async function command<T>(
  contents: WebContents,
  method: string,
  parameters: Record<string, unknown> = {},
  sessionId?: string
): Promise<T> {
  if (!contents.debugger.isAttached()) contents.debugger.attach('1.3')
  return contents.debugger.sendCommand(method, parameters, sessionId) as Promise<T>
}

function flattenFrames(tree: FrameTree): FrameEntry[] {
  const entries: FrameEntry[] = []
  const queue = (tree.childFrames ?? []).slice(0, MAX_FRAME_DISCOVERY).map((child) => ({
    child,
    parentId: tree.frame.id
  }))
  for (let index = 0; index < queue.length && entries.length < MAX_FRAME_DISCOVERY; index++) {
    const { child, parentId } = queue[index]!
    entries.push({ frameId: child.frame.id, parentId, origin: child.frame.securityOrigin })
    for (const nested of child.childFrames ?? []) {
      if (queue.length < MAX_FRAME_DISCOVERY)
        queue.push({ child: nested, parentId: child.frame.id })
    }
  }
  return entries
}

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function frameTree(contents: WebContents, sessionId?: string): Promise<FrameTree> {
  const result = await command<{ frameTree: FrameTree }>(
    contents,
    'Page.getFrameTree',
    {},
    sessionId
  )
  return result.frameTree
}

async function discover(
  contents: WebContents
): Promise<{ tree: FrameTree; entries: FrameEntry[]; rejected: FrameEntry[] }> {
  const tree = await frameTree(contents)
  const entries = flattenFrames(tree)
  const rootTarget = await command<{ targetInfo: TargetInfo }>(contents, 'Target.getTargetInfo')
  if (rootTarget.targetInfo.targetId !== tree.frame.id)
    throw new Error('CDP target does not match the current page frame.')
  const targets = await command<{ targetInfos: TargetInfo[] }>(contents, 'Target.getTargets')
  const pending = targets.targetInfos
    .slice(0, MAX_FRAME_DISCOVERY)
    .filter((target) => target.type === 'iframe')
  const known = new Set([tree.frame.id, ...entries.map((entry) => entry.frameId)])
  const rejected: FrameEntry[] = []
  if (
    targets.targetInfos.length > MAX_FRAME_DISCOVERY ||
    entries.length >= MAX_FRAME_DISCOVERY ||
    (tree.childFrames?.length ?? 0) > MAX_FRAME_DISCOVERY
  ) {
    rejected.push({ frameId: '*', parentId: tree.frame.id })
  }
  let added = true
  while (added) {
    added = false
    for (let index = pending.length - 1; index >= 0; index--) {
      const target = pending[index]!
      if (!target.parentFrameId || !known.has(target.parentFrameId)) continue
      pending.splice(index, 1)
      if (
        !rootTarget.targetInfo.browserContextId ||
        target.browserContextId !== rootTarget.targetInfo.browserContextId ||
        entries.some(
          (entry) => entry.frameId === target.targetId && entry.parentId !== target.parentFrameId
        )
      ) {
        rejected.push({ frameId: target.targetId, parentId: target.parentFrameId, target })
        continue
      }
      if (!known.has(target.targetId)) {
        if (entries.length >= MAX_FRAME_DISCOVERY) {
          rejected.push({ frameId: target.targetId, parentId: target.parentFrameId, target })
          continue
        }
        entries.push({ frameId: target.targetId, parentId: target.parentFrameId, target })
        known.add(target.targetId)
        added = true
      } else {
        const entry = entries.find((item) => item.frameId === target.targetId)!
        entry.target = target
      }
    }
  }
  return { tree, entries, rejected }
}

async function frameSession(contents: WebContents, frameId: string): Promise<string> {
  const existing = frameSessions.get(contents)?.get(frameId)
  if (existing) {
    try {
      const current = await frameTree(contents, existing)
      if (current.frame.id === frameId) return existing
    } catch {
      /* Detached CDP session: attach to the exact current target again. */
    }
    frameSessions.get(contents)?.delete(frameId)
  }
  const result = await command<{ sessionId: string }>(contents, 'Target.attachToTarget', {
    targetId: frameId,
    flatten: true
  })
  const sessions = frameSessions.get(contents) ?? new Map<string, string>()
  sessions.set(frameId, result.sessionId)
  frameSessions.set(contents, sessions)
  await command(contents, 'Page.enable', {}, result.sessionId)
  await command(contents, 'Runtime.enable', {}, result.sessionId)
  return result.sessionId
}

/** An isolated-world context is scoped to the precise CDP frame, not its URL or DOM index. */
export async function collectBrowserFrameSnapshots(
  contents: WebContents,
  options: { generation: string; maxRefs: number; query?: string; scopeRef?: string }
): Promise<BrowserFrameSnapshotCollection> {
  const { tree, entries, rejected } = await discover(contents)
  const byId = new Map(entries.map((item) => [item.frameId, item]))
  const results: BrowserFrameSnapshotCollection = {
    frames: [],
    unavailableFrames: rejected.map((entry) => ({
      frameId: entry.frameId,
      reason:
        entry.frameId === '*'
          ? 'Frame discovery truncated after 256 frames/targets.'
          : 'OOPIF is not owned by this page; refusing a different browser context or parent frame.'
    }))
  }
  let visited = 0
  let remainingRefs = Math.max(0, Math.min(options.maxRefs, 200))
  for (const entry of entries) {
    if (rejected.some((item) => item.frameId === entry.frameId)) continue
    // The top snapshot already traverses frames reachable from its own origin.
    // A same-origin child of a cross-origin frame is traversed there as well.
    const parentOrigin = byId.get(entry.parentId)?.origin ?? tree.frame.securityOrigin
    if (!entry.target && entry.origin === parentOrigin) continue
    if (visited >= MAX_CROSS_ORIGIN_FRAMES || remainingRefs <= 0) {
      results.unavailableFrames.push({
        frameId: entry.frameId,
        reason: 'Frame omitted: cross-origin frame or total ref budget reached.'
      })
      continue
    }
    visited++
    try {
      const sessionId = entry.target ? await frameSession(contents, entry.frameId) : undefined
      if (sessionId) {
        const ownTree = await frameTree(contents, sessionId)
        if (ownTree.frame.id !== entry.frameId)
          throw new Error(`OOPIF ${entry.frameId} target/frame mismatch.`)
        entry.origin = ownTree.frame.securityOrigin
        if (entry.origin === parentOrigin) continue
      }
      const world = await command<{ executionContextId: number }>(
        contents,
        'Page.createIsolatedWorld',
        {
          frameId: entry.frameId,
          worldName: 'yachiyo-browser',
          grantUniveralAccess: false
        },
        sessionId
      )
      const context = {
        frameId: entry.frameId,
        ...(sessionId ? { sessionId } : {}),
        contextId: world.executionContextId
      }
      const value = await executeBrowserFrameScript(
        contents,
        context,
        buildBrowserAutomationSnapshotScript(remainingRefs, {
          generation: `${options.generation}:${entry.frameId}`,
          ...(options.query ? { query: options.query } : {}),
          ...(options.scopeRef ? { scopeRef: options.scopeRef } : {})
        })
      )
      const snapshot = value as Omit<BrowserAutomationSnapshot, 'refCount'>
      if (!snapshot || !Array.isArray(snapshot.refs))
        throw new Error(`Frame ${entry.frameId} returned an invalid snapshot.`)
      remainingRefs -= snapshot.refs.length
      results.frames.push({ ...context, snapshot: { ...snapshot, refCount: snapshot.refs.length } })
    } catch (error) {
      results.unavailableFrames.push({ frameId: entry.frameId, reason: reason(error) })
    }
  }
  return results
}

/** Run code in the same isolated world as that frame's registry. */
export async function executeBrowserFrameScript(
  contents: WebContents,
  frameContext: FrameContext,
  script: string
): Promise<unknown> {
  const response = await command<{
    result?: { value?: unknown }
    exceptionDetails?: { text?: string; exception?: { description?: string } }
  }>(
    contents,
    'Runtime.evaluate',
    {
      contextId: frameContext.contextId,
      expression: script,
      returnByValue: true,
      awaitPromise: true
    },
    frameContext.sessionId
  )
  if (response.exceptionDetails) {
    throw new Error(
      response.exceptionDetails.exception?.description ||
        response.exceptionDetails.text ||
        'Frame evaluation failed.'
    )
  }
  return response.result?.value
}

/** Translate coordinates through the actual frame owner nodes, including nested frames. */
export async function framePointToMain(
  contents: WebContents,
  context: FrameContext,
  point: { x: number; y: number }
): Promise<{ x: number; y: number }> {
  const { tree, entries: frameEntries } = await discover(contents)
  const entries = new Map(frameEntries.map((entry) => [entry.frameId, entry]))
  let frameId = context.frameId
  let position = point
  while (frameId !== tree.frame.id) {
    const entry = entries.get(frameId)
    if (!entry) throw new Error(`Frame ${frameId} is detached; take a fresh snapshot.`)
    let parentId = entry.parentId
    let sessionId: string | undefined
    while (parentId !== tree.frame.id) {
      sessionId = entries.get(parentId)?.target
        ? await frameSession(contents, parentId)
        : frameSessions.get(contents)?.get(parentId)
      if (sessionId) break
      const parent = entries.get(parentId)
      if (!parent) throw new Error(`Frame ${parentId} is detached; take a fresh snapshot.`)
      parentId = parent.parentId
    }
    const owner = await command<{ backendNodeId: number }>(
      contents,
      'DOM.getFrameOwner',
      { frameId },
      sessionId
    )
    const box = await command<{ model: { content: number[]; width: number; height: number } }>(
      contents,
      'DOM.getBoxModel',
      { backendNodeId: owner.backendNodeId },
      sessionId
    )
    const { content: quad } = box.model
    const currentSession =
      frameId === context.frameId ? context.sessionId : frameSessions.get(contents)?.get(frameId)
    const currentContext =
      frameId === context.frameId
        ? context.contextId
        : (
            await command<{ executionContextId: number }>(
              contents,
              'Page.createIsolatedWorld',
              {
                frameId,
                worldName: 'yachiyo-browser',
                grantUniveralAccess: false
              },
              currentSession
            )
          ).executionContextId
    const size = (await executeBrowserFrameScript(
      contents,
      {
        frameId,
        ...(currentSession ? { sessionId: currentSession } : {}),
        contextId: currentContext
      },
      '({width:innerWidth,height:innerHeight})'
    )) as { width: number; height: number }
    if (quad.length !== 8 || size.width <= 0 || size.height <= 0)
      throw new Error(`Frame ${frameId} has no usable content box.`)
    const fraction = { x: position.x / size.width, y: position.y / size.height }
    position = {
      x:
        quad[0]! +
        ((quad[2]! - quad[0]!) * position.x) / size.width +
        ((quad[6]! - quad[0]!) * position.y) / size.height,
      y:
        quad[1]! +
        ((quad[3]! - quad[1]!) * position.x) / size.width +
        ((quad[7]! - quad[1]!) * position.y) / size.height
    }
    const parentWorld = await command<{ executionContextId: number }>(
      contents,
      'Page.createIsolatedWorld',
      {
        frameId: entry.parentId,
        worldName: 'yachiyo-browser',
        grantUniveralAccess: false
      },
      sessionId
    )
    const ownerNode = await command<{ object: { objectId: string } }>(
      contents,
      'DOM.resolveNode',
      {
        backendNodeId: owner.backendNodeId,
        executionContextId: parentWorld.executionContextId
      },
      sessionId
    )
    try {
      const hit = await command<{ result: { value?: boolean } }>(
        contents,
        'Runtime.callFunctionOn',
        {
          objectId: ownerNode.object.objectId,
          functionDeclaration: `function(u,v) {
              if (!this.isConnected) return false
              const rect = this.getBoundingClientRect()
              let x = rect.left + (this.clientLeft + u*this.clientWidth)*rect.width/this.offsetWidth
              let y = rect.top + (this.clientTop + v*this.clientHeight)*rect.height/this.offsetHeight
              if (this.getRootNode().elementFromPoint(x,y) !== this) return false
              let view = this.ownerDocument.defaultView
              while (view.frameElement) {
                const frame = view.frameElement, box = frame.getBoundingClientRect()
                x = box.left + (frame.clientLeft+x)*box.width/frame.offsetWidth
                y = box.top + (frame.clientTop+y)*box.height/frame.offsetHeight
                if (frame.getRootNode().elementFromPoint(x,y) !== frame) return false
                view = frame.ownerDocument.defaultView
              }
              return true
            }`,
          arguments: [{ value: fraction.x }, { value: fraction.y }],
          returnByValue: true
        },
        sessionId
      )
      if (!hit.result.value) throw new Error('Target frame is covered by another element.')
    } finally {
      await command(
        contents,
        'Runtime.releaseObject',
        { objectId: ownerNode.object.objectId },
        sessionId
      )
    }
    // The quad is already relative to the owning CDP target. Same-process
    // ancestors must not be translated a second time.
    frameId = parentId
  }
  return position
}
