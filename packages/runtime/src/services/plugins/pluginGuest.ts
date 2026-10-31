import type { PluginCodec, PluginPacket } from './pluginCodec.ts'
import type { PluginDefinition, PluginHooks } from './pluginTypes.ts'

/** Runs entirely inside QuickJS; none of these functions are host functions. */
export function createPluginGuest(codec: PluginCodec): {
  validate(definition: PluginDefinition, allowed: string): string
  invoke(
    definition: PluginDefinition,
    hook: keyof PluginHooks,
    packet: PluginPacket,
    call: (json: string) => Promise<string>
  ): Promise<PluginPacket>
} {
  const { parse, stringify } = JSON
  const { keys } = Object
  function assertObject(value: unknown, label: string): void {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error(label + ' must be an object')
    }
  }
  return {
    validate(definition, allowed) {
      assertObject(definition, 'Default export')
      for (const key of keys(definition)) {
        if (key !== 'apiVersion' && key !== 'hooks') {
          throw new Error('Unsupported plugin field: ' + key + '. Version 1 supports hooks only.')
        }
      }
      if (definition.apiVersion !== 1) throw new Error('apiVersion must be 1')
      assertObject(definition.hooks, 'hooks')
      const names = keys(definition.hooks) as (keyof PluginHooks)[]
      if (names.length === 0) throw new Error('At least one hook is required')
      const hookNames = new Set(parse(allowed))
      for (const name of names) {
        if (!hookNames.has(name)) throw new Error('Unsupported hook: ' + name)
        if (typeof definition.hooks[name] !== 'function') {
          throw new Error('Hook ' + name + ' must be a function')
        }
      }
      return stringify(names)
    },
    async invoke(definition, hook, packet, call) {
      const request = async (input: unknown): Promise<unknown> => {
        const encoded = codec.encode(input)
        if (encoded.buffers.length) throw new Error('Plugin state requires JSON values')
        return parse(await call(encoded.json))
      }
      const api = {
        state: {
          read: (scope: string, key: string) => request({ operation: 'read', scope, key }),
          write: (scope: string, key: string, expectedVersion: number, value: unknown) =>
            request({ operation: 'write', scope, key, expectedVersion, value })
        }
      }
      const fn = definition.hooks[hook] as (event: unknown, api: unknown) => unknown
      return codec.encode(await fn.call(definition.hooks, codec.decode(packet), api))
    }
  }
}
