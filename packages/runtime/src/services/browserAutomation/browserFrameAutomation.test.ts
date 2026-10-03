import assert from 'node:assert/strict'
import test from 'node:test'

import type { WebContents } from 'electron'

import {
  collectBrowserFrameSnapshots,
  executeBrowserFrameScript,
  framePointToMain
} from './browserFrameAutomation.ts'

type Command = { method: string; parameters: Record<string, unknown>; sessionId?: string }

function fakeContents(respond: (command: Command) => unknown): {
  contents: WebContents
  commands: Command[]
} {
  const commands: Command[] = []
  const contents = {
    debugger: {
      isAttached: () => true,
      sendCommand: async (
        method: string,
        parameters: Record<string, unknown> = {},
        sessionId?: string
      ) => {
        const command = { method, parameters, sessionId }
        commands.push(command)
        return respond(command)
      }
    }
  } as unknown as WebContents
  return { contents, commands }
}

const frameTree = {
  frameTree: {
    frame: { id: 'root', securityOrigin: 'https://top.test' },
    childFrames: [
      { frame: { id: 'cross', securityOrigin: 'https://other.test' } },
      { frame: { id: 'same', securityOrigin: 'https://top.test' } }
    ]
  }
}

const frameSnapshot = {
  url: 'https://other.test/',
  pageText: { headings: ['Frame'], snippets: [] },
  refs: [{ ref: 'generation:cross:1', tag: 'button', label: 'Continue' }]
}

test('frame snapshot uses isolated world in cross-origin frame, not duplicate same-origin content', async () => {
  const { contents, commands } = fakeContents(({ method, parameters }) => {
    if (method === 'Page.getFrameTree') return frameTree
    if (method === 'Target.getTargets') return { targetInfos: [] }
    if (method === 'Target.getTargetInfo')
      return { targetInfo: { targetId: 'root', browserContextId: 'ours' } }
    if (method === 'Page.createIsolatedWorld') {
      assert.equal(parameters.frameId, 'cross')
      return { executionContextId: 31 }
    }
    if (method === 'Runtime.evaluate') return { result: { value: frameSnapshot } }
    throw new Error(`Unexpected ${method}`)
  })
  const results = await collectBrowserFrameSnapshots(contents, {
    generation: 'generation',
    maxRefs: 5,
    query: 'Continue'
  })
  assert.equal(results.frames.length, 1)
  assert.deepEqual(results.frames[0], {
    frameId: 'cross',
    contextId: 31,
    snapshot: { ...frameSnapshot, refCount: 1 }
  })
  const evaluated = commands.find(({ method }) => method === 'Runtime.evaluate')!
  assert.equal(evaluated.parameters.contextId, 31)
  assert.match(String(evaluated.parameters.expression), /Continue/)
  assert.ok(commands.every((command) => command.sessionId === undefined))
})

test('frame evaluation surfaces browser exception and uses the frame context', async () => {
  const { contents, commands } = fakeContents(({ method }) => {
    if (method === 'Runtime.evaluate') return { exceptionDetails: { text: 'Stale browser ref' } }
    throw new Error(method)
  })
  await assert.rejects(
    executeBrowserFrameScript(contents, { frameId: 'cross', contextId: 31 }, 'return 1'),
    /Stale browser ref/
  )
  assert.equal(commands[0]?.parameters.contextId, 31)
  assert.equal(commands[0]?.parameters.awaitPromise, true)
})

test('frame point uses owner content quad instead of frame URL or DOM order', async () => {
  const { contents, commands } = fakeContents(({ method, parameters }) => {
    if (method === 'Page.getFrameTree') return frameTree
    if (method === 'Target.getTargetInfo')
      return { targetInfo: { targetId: 'root', browserContextId: 'ours' } }
    if (method === 'Target.getTargets') return { targetInfos: [] }
    if (method === 'DOM.getFrameOwner') {
      assert.equal(parameters.frameId, 'cross')
      return { backendNodeId: 72 }
    }
    if (method === 'DOM.getBoxModel')
      return {
        model: { content: [40, 60, 240, 60, 240, 160, 40, 160], width: 200, height: 100 }
      }
    if (method === 'Runtime.evaluate') return { result: { value: { width: 200, height: 100 } } }
    if (method === 'Page.createIsolatedWorld') return { executionContextId: 1 }
    if (method === 'DOM.resolveNode') return { object: { objectId: 'owner' } }
    if (method === 'Runtime.callFunctionOn') return { result: { value: true } }
    if (method === 'Runtime.releaseObject') return {}
    throw new Error(method)
  })
  assert.deepEqual(
    await framePointToMain(contents, { frameId: 'cross', contextId: 31 }, { x: 10, y: 20 }),
    { x: 50, y: 80 }
  )
  assert.deepEqual(commands.find(({ method }) => method === 'DOM.getBoxModel')?.parameters, {
    backendNodeId: 72
  })
})

test('OOPIF routing must match frame identity and owning page, never URL', async () => {
  const { contents, commands } = fakeContents(({ method }) => {
    if (method === 'Page.getFrameTree') return frameTree
    if (method === 'Target.getTargets')
      return {
        targetInfos: [
          {
            type: 'iframe',
            targetId: 'cross',
            parentFrameId: 'root',
            browserContextId: 'different-page'
          }
        ]
      }
    if (method === 'Target.getTargetInfo')
      return { targetInfo: { targetId: 'root', browserContextId: 'ours' } }
    throw new Error(method)
  })
  const collected = await collectBrowserFrameSnapshots(contents, { generation: 'g', maxRefs: 5 })
  assert.deepEqual(
    collected.frames.map((item) => item.frameId),
    []
  )
  assert.deepEqual(
    collected.unavailableFrames.map((item) => item.frameId),
    ['cross']
  )
  assert.match(collected.unavailableFrames[0]!.reason, /different page|not owned|OOPIF/i)
  assert.equal(
    commands.some(({ method }) => method === 'Target.attachToTarget'),
    false
  )
})

test('same-process ancestor offsets are not added twice to CDP target-relative quads', async () => {
  const { contents } = fakeContents(({ method, parameters }) => {
    if (method === 'Page.getFrameTree')
      return {
        frameTree: {
          frame: { id: 'root', securityOrigin: 'https://top.test' },
          childFrames: [
            {
              frame: { id: 'outer', securityOrigin: 'https://top.test' },
              childFrames: [{ frame: { id: 'cross', securityOrigin: 'https://other.test' } }]
            }
          ]
        }
      }
    if (method === 'Target.getTargetInfo')
      return { targetInfo: { targetId: 'root', browserContextId: 'ours' } }
    if (method === 'Target.getTargets') return { targetInfos: [] }
    if (method === 'DOM.getFrameOwner') {
      assert.equal(parameters.frameId, 'cross')
      return { backendNodeId: 72 }
    }
    if (method === 'DOM.getBoxModel')
      return {
        model: { content: [130, 130, 330, 130, 330, 230, 130, 230], width: 200, height: 100 }
      }
    if (method === 'Runtime.evaluate') return { result: { value: { width: 200, height: 100 } } }
    if (method === 'Page.createIsolatedWorld') return { executionContextId: 1 }
    if (method === 'DOM.resolveNode') return { object: { objectId: 'owner' } }
    if (method === 'Runtime.callFunctionOn') return { result: { value: true } }
    if (method === 'Runtime.releaseObject') return {}
    throw new Error(method)
  })
  assert.deepEqual(
    await framePointToMain(contents, { frameId: 'cross', contextId: 31 }, { x: 60, y: 40 }),
    { x: 190, y: 170 }
  )
})

test('collection globally bounds frame count and refs and reports omitted frames', async () => {
  const children = Array.from({ length: 18 }, (_, index) => ({
    frame: {
      id: `frame-${index}`,
      securityOrigin: `https://site-${index}.test`
    }
  }))
  let evaluations = 0
  const { contents } = fakeContents(({ method, parameters }) => {
    if (method === 'Page.getFrameTree')
      return {
        frameTree: {
          frame: { id: 'root', securityOrigin: 'https://top.test' },
          childFrames: children
        }
      }
    if (method === 'Target.getTargetInfo')
      return { targetInfo: { targetId: 'root', browserContextId: 'ours' } }
    if (method === 'Target.getTargets') return { targetInfos: [] }
    if (method === 'Page.createIsolatedWorld')
      return { executionContextId: Number(String(parameters.frameId).split('-')[1]) + 1 }
    if (method === 'Runtime.evaluate') {
      evaluations++
      return {
        result: {
          value: {
            url: 'https://site.test',
            pageText: { headings: [], snippets: [] },
            refs: [{ ref: `r${evaluations}`, tag: 'button' }]
          }
        }
      }
    }
    throw new Error(method)
  })
  const result = await collectBrowserFrameSnapshots(contents, { generation: 'budget', maxRefs: 3 })
  assert.equal(result.frames.length, 3)
  assert.equal(
    result.frames.reduce((sum, item) => sum + item.snapshot.refCount, 0),
    3
  )
  assert.ok(result.unavailableFrames.some((item) => /budget|omitted/i.test(item.reason)))
  assert.equal(evaluations, 3)
})

test('owned OOPIF reattaches when a cached CDP session becomes invalid', async () => {
  let attached = 0
  let stale = false
  const rootOnly = { frameTree: { frame: { id: 'root', securityOrigin: 'https://top.test' } } }
  const { contents, commands } = fakeContents(({ method, sessionId }) => {
    if (method === 'Page.getFrameTree') {
      if (!sessionId) return rootOnly
      if (stale && sessionId === 'session-1') throw new Error('Session with given id not found')
      return { frameTree: { frame: { id: 'cross', securityOrigin: 'https://other.test' } } }
    }
    if (method === 'Target.getTargetInfo')
      return { targetInfo: { targetId: 'root', browserContextId: 'ours' } }
    if (method === 'Target.getTargets')
      return {
        targetInfos: [
          { type: 'iframe', targetId: 'cross', parentFrameId: 'root', browserContextId: 'ours' }
        ]
      }
    if (method === 'Target.attachToTarget') return { sessionId: `session-${++attached}` }
    if (method === 'Page.enable' || method === 'Runtime.enable') return {}
    if (method === 'Page.createIsolatedWorld') return { executionContextId: attached }
    if (method === 'Runtime.evaluate') return { result: { value: frameSnapshot } }
    throw new Error(method)
  })
  assert.equal(
    (await collectBrowserFrameSnapshots(contents, { generation: 'g1', maxRefs: 5 })).frames.length,
    1
  )
  stale = true
  assert.equal(
    (await collectBrowserFrameSnapshots(contents, { generation: 'g2', maxRefs: 5 })).frames.length,
    1
  )
  assert.equal(attached, 2)
  assert.equal(commands.at(-1)?.sessionId, 'session-2')
})

test('frame point uses frame viewport dimensions rather than border-box width', async () => {
  const { contents } = fakeContents(({ method }) => {
    if (method === 'Page.getFrameTree') return frameTree
    if (method === 'Target.getTargetInfo')
      return { targetInfo: { targetId: 'root', browserContextId: 'ours' } }
    if (method === 'Target.getTargets') return { targetInfos: [] }
    if (method === 'DOM.getFrameOwner') return { backendNodeId: 72 }
    if (method === 'DOM.getBoxModel')
      return {
        model: { content: [88, 128, 338, 128, 338, 278, 88, 278], width: 266, height: 166 }
      }
    if (method === 'Runtime.evaluate') return { result: { value: { width: 250, height: 150 } } }
    if (method === 'Page.createIsolatedWorld') return { executionContextId: 1 }
    if (method === 'DOM.resolveNode') return { object: { objectId: 'owner' } }
    if (method === 'Runtime.callFunctionOn') return { result: { value: true } }
    if (method === 'Runtime.releaseObject') return {}
    throw new Error(method)
  })
  assert.deepEqual(
    await framePointToMain(contents, { frameId: 'cross', contextId: 31 }, { x: 205, y: 103 }),
    { x: 293, y: 231 }
  )
})
