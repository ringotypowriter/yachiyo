import { normalizePluginValue } from './pluginWire.ts'

// A self-contained worker also runs from the bundled desktop and headless servers.
export const PLUGIN_WORKER_SCRIPT = String.raw`
const { parentPort } = require('node:worker_threads')
const normalizePluginValue = ${normalizePluginValue.toString()}
const plugins = []
const hookNames = new Set(['beforeModel', 'beforeTool', 'afterTool'])

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
  try {
    const value = request.type === 'initialize'
      ? await initialize(request.sources)
      : await plugins[request.pluginIndex].hooks[request.hook](request.event)
    parentPort.postMessage({ id: request.id, value: normalizePluginValue(value) })
  } catch (error) {
    parentPort.postMessage({
      id: request.id,
      error: error instanceof Error ? error.message : String(error)
    })
  }
})
`
