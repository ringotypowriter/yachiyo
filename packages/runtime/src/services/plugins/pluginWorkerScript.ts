import { normalizePluginValue } from './pluginWire.ts'
import { PLUGIN_HOOK_NAMES } from './pluginContract.ts'

// A self-contained worker also runs from the bundled desktop and headless servers.
export const PLUGIN_WORKER_SCRIPT = String.raw`
const { parentPort } = require('node:worker_threads')
const normalizePluginValue = ${normalizePluginValue.toString()}
const plugins = []
const hookNames = new Set(${JSON.stringify(PLUGIN_HOOK_NAMES)})
const stateCalls = new Map()
let nextStateId = 0

function createApi(request) {
  const call = (input) => {
    const stateId = ++nextStateId
    const promise = new Promise((resolve, reject) => {
      stateCalls.set(stateId, { resolve, reject })
      parentPort.postMessage({ type: 'state', id: request.id, stateId, input })
    })
    return promise
  }
  return { state: {
    read: (scope, key) => call({ operation: 'read', scope, key }),
    write: (scope, key, expectedVersion, value) => call({ operation: 'write', scope, key, expectedVersion, value })
  } }
}

function assertObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(label + ' must be an object')
  }
}

async function initialize(sources) {
  for (const source of sources) {
    try {
      const url = 'data:text/javascript;base64,' +
        Buffer.from(source.source).toString('base64') + '#' + encodeURIComponent(source.name)
      const definition = (await import(url)).default
      assertObject(definition, 'Default export')
      for (const key of Object.keys(definition)) {
        if (key !== 'apiVersion' && key !== 'hooks') {
          throw new Error('Unsupported plugin field: ' + key + '. Version 1 supports hooks only.')
        }
      }
      if (definition.apiVersion !== 1) throw new Error('apiVersion must be 1')
      assertObject(definition.hooks, 'hooks')
      const names = Object.keys(definition.hooks)
      if (names.length === 0) throw new Error('At least one hook is required')
      for (const name of names) {
        if (!hookNames.has(name)) throw new Error('Unsupported hook: ' + name)
        if (typeof definition.hooks[name] !== 'function') {
          throw new Error('Hook ' + name + ' must be a function')
        }
      }
      plugins.push({ ...source, hooks: definition.hooks })
    } catch (error) {
      throw new Error('Plugin ' + source.name + ': ' + (error instanceof Error ? error.message : String(error)))
    }
  }
  return plugins.map(plugin => ({
    name: plugin.name, revision: plugin.revision, hooks: Object.keys(plugin.hooks)
  }))
}

parentPort.on('message', async (request) => {
  if (request.type === 'state-result') {
    const call = stateCalls.get(request.stateId)
    if (!call) return
    stateCalls.delete(request.stateId)
    if (request.error !== undefined) call.reject(new Error(request.error))
    else call.resolve(request.value)
    return
  }
  try {
    const value = request.type === 'initialize'
      ? await initialize(request.sources)
      : await plugins[request.pluginIndex].hooks[request.hook](request.event, createApi(request))
    parentPort.postMessage({ id: request.id, value: normalizePluginValue(value) })
  } catch (error) {
    parentPort.postMessage({
      id: request.id,
      error: error instanceof Error ? error.message : String(error)
    })
  }
})
`
