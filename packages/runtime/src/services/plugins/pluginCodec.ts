export interface PluginPacket {
  json: string
  buffers: ArrayBuffer[]
}

export interface PluginCodec {
  encode(value: unknown): PluginPacket
  decode(packet: PluginPacket): unknown
}

/** Also evaluated inside QuickJS. Keep this factory self-contained. */
export function createPluginCodec(): PluginCodec {
  const { stringify, parse } = JSON
  const { entries, fromEntries, getPrototypeOf } = Object
  const { isArray } = Array
  const Bytes = Uint8Array
  const Binary = ArrayBuffer
  const limit = 16 * 1024 * 1024
  const maxDepth = 100

  return {
    encode(value) {
      const buffers: ArrayBuffer[] = []
      const ancestors = new WeakSet<object>()
      let bytes = 0
      function visit(input: unknown, depth: number): unknown {
        if (depth > maxDepth) throw new Error('Plugin data exceeds 100 nesting levels')
        if (input === undefined) return ['undefined']
        if (input === null || typeof input === 'string' || typeof input === 'boolean') return input
        if (typeof input === 'number') {
          return Number.isFinite(input) ? input : ['number', String(input)]
        }
        if (typeof input !== 'object') throw new Error('Plugin data must be serializable')
        if (ancestors.has(input)) throw new Error('Plugin data cannot contain cycles')
        ancestors.add(input)
        let result: unknown
        if (input instanceof Bytes || input instanceof Binary) {
          bytes += input.byteLength
          if (bytes > limit) throw new Error('Plugin data exceeds 16 MiB')
          const index = buffers.length
          buffers.push(input instanceof Bytes ? new Bytes(input).buffer : input.slice(0))
          result = [input instanceof Bytes ? 'bytes' : 'buffer', index]
        } else if (isArray(input)) {
          result = ['array', input.map((child) => visit(child, depth + 1))]
        } else if (getPrototypeOf(input) === Object.prototype || getPrototypeOf(input) === null) {
          result = ['object', entries(input).map(([key, child]) => [key, visit(child, depth + 1)])]
        } else {
          throw new Error('Plugin data supports plain objects, arrays and binary attachments')
        }
        ancestors.delete(input)
        return result
      }
      const json = stringify(visit(value, 0))
      if (json.length * 2 + bytes > limit) throw new Error('Plugin data exceeds 16 MiB')
      return { json, buffers }
    },
    decode({ json, buffers }) {
      if (json.length * 2 + buffers.reduce((size, buffer) => size + buffer.byteLength, 0) > limit) {
        throw new Error('Plugin data exceeds 16 MiB')
      }
      function visit(input: unknown, depth: number): unknown {
        if (depth > maxDepth) throw new Error('Plugin data exceeds 100 nesting levels')
        if (!isArray(input)) return input
        const [tag, data] = input
        switch (tag) {
          case 'undefined':
            return undefined
          case 'number':
            return Number(data)
          case 'bytes':
          case 'buffer': {
            const buffer = buffers[data]
            if (!(buffer instanceof Binary)) throw new Error('Invalid plugin binary attachment')
            return tag === 'bytes' ? new Bytes(buffer) : buffer
          }
          case 'array':
            return data.map((child: unknown) => visit(child, depth + 1))
          case 'object':
            return fromEntries(
              data.map(([key, child]: [string, unknown]) => [key, visit(child, depth + 1)])
            )
          default:
            throw new Error('Invalid plugin data encoding')
        }
      }
      return visit(parse(json), 0)
    }
  }
}
