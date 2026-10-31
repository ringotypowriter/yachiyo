import { parentPort } from 'node:worker_threads'
import { getQuickJS } from 'quickjs-emscripten'
import { createQuickJsPlugin } from './pluginQuickJs.ts'
import type { PluginHooks, PluginSource } from './pluginTypes.ts'

if (!parentPort) throw new Error('Plugin worker requires a parent port')
const port = parentPort
const plugins: Awaited<ReturnType<typeof createQuickJsPlugin>>[] = []
const stateCalls = new Map<
  number,
  { resolve: (value: unknown) => void; reject: (error: Error) => void }
>()
let nextStateId = 0

type Request =
  | {
      type: 'initialize'
      id: number
      deadline: number
      sources: PluginSource[]
      hookNames: string[]
    }
  | {
      type: 'hook'
      id: number
      deadline: number
      pluginIndex: number
      hook: keyof PluginHooks
      event: unknown
    }
  | { type: 'state-result'; stateId: number; value?: unknown; error?: string }

port.on('message', async (request: Request) => {
  if (request.type === 'state-result') {
    const call = stateCalls.get(request.stateId)
    if (!call) return
    stateCalls.delete(request.stateId)
    if (request.error !== undefined) call.reject(new Error(request.error))
    else call.resolve(request.value)
    return
  }
  try {
    let value: unknown
    if (request.type === 'initialize') {
      const quickjs = await getQuickJS()
      for (const source of request.sources) {
        try {
          plugins.push(
            await createQuickJsPlugin(quickjs, source, request.hookNames, request.deadline)
          )
        } catch (error) {
          throw new Error(
            `Plugin ${source.name}: ${error instanceof Error ? error.message : String(error)}`
          )
        }
      }
      value = plugins.map((plugin) => plugin.descriptor)
    } else {
      value = await plugins[request.pluginIndex].invoke(
        request.hook,
        request.event,
        request.deadline,
        (input) => {
          const stateId = ++nextStateId
          return new Promise((resolve, reject) => {
            stateCalls.set(stateId, { resolve, reject })
            port.postMessage({ type: 'state', id: request.id, stateId, input })
          })
        }
      )
    }
    port.postMessage({ id: request.id, value })
  } catch (error) {
    port.postMessage({
      id: request.id,
      error: error instanceof Error ? error.message : String(error)
    })
  }
})
