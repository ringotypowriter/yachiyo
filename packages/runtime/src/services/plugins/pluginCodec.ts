export interface PluginPacket {
  json: string
  buffers: ArrayBuffer[]
  strings: string[]
}

export interface PluginCodec {
  encode(value: unknown, references?: readonly string[]): PluginPacket
  decode(packet: PluginPacket, references?: readonly string[]): unknown
}

/** Also evaluated inside QuickJS. Keep this factory self-contained. */
export function createPluginCodec(rememberInputFields = false): PluginCodec {
  const { stringify, parse } = JSON
  const { entries, fromEntries, getPrototypeOf } = Object
  const { isArray } = Array
  const Bytes = Uint8Array
  const Binary = ArrayBuffer
  const wellFormed = Function.call.bind(String.prototype.isWellFormed) as (value: string) => boolean
  const includes = Function.call.bind(String.prototype.includes) as (
    value: string,
    search: string
  ) => boolean
  const limit = 16 * 1024 * 1024
  const maxDepth = 100
  // Field metadata keeps only an ID, so a retained message does not retain every
  // string from an earlier hook. IDs prevent reuse against a later input table.
  const generations = new WeakMap<readonly string[], number>()
  const fields = new WeakMap<object, Map<string | number, { generation: number; index: number }>>()
  let nextGeneration = 0

  return {
    encode(value, references) {
      const buffers: ArrayBuffer[] = []
      const strings: string[] = []
      let incoming: Map<string, number> | undefined
      const generation = references === undefined ? undefined : generations.get(references)
      const outgoing = new Map<string, number>()
      const ancestors = new WeakSet<object>()
      let bytes = 0
      function visit(
        input: unknown,
        depth: number,
        owner?: object,
        key?: string | number
      ): unknown {
        if (depth > maxDepth) throw new Error('Plugin data exceeds 100 nesting levels')
        if (input === undefined) return ['undefined']
        if (typeof input === 'string') {
          if (input.length < 1024) return input
          let reference: number | undefined
          if (references?.length) {
            const field =
              owner === undefined || key === undefined ? undefined : fields.get(owner)?.get(key)
            if (field && field.generation === generation && input === references[field.index]) {
              reference = field.index
            } else if (references.length === 1) {
              if (input === references[0]) reference = 0
            } else {
              incoming ??= new Map(references.map((value, index) => [value, index]))
              reference = incoming.get(input)
            }
          }
          if (reference !== undefined) {
            bytes += input.length * 2
            if (bytes > limit) throw new Error('Plugin data exceeds 16 MiB')
            return ['reference', reference]
          }
          // Guest results reuse incoming text. New guest text stays in JSON so it does
          // not need a second UTF-8 transfer or a scan for transport-unsafe characters.
          if (references !== undefined) return input
          // QuickJS's UTF-8 string API truncates at NUL and changes lone surrogates.
          // JSON escaping preserves those values. Ordinary long text avoids JSON entirely.
          if (includes(input, '\0') || !wellFormed(input)) return input
          bytes += input.length * 2
          if (bytes > limit) throw new Error('Plugin data exceeds 16 MiB')
          let index = outgoing.get(input)
          if (index === undefined) {
            index = strings.length
            outgoing.set(input, index)
            strings.push(input)
          }
          return ['string', index]
        }
        if (input === null || typeof input === 'boolean') return input
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
          result = ['array', input.map((child, index) => visit(child, depth + 1, input, index))]
        } else if (getPrototypeOf(input) === Object.prototype || getPrototypeOf(input) === null) {
          result = [
            'object',
            entries(input).map(([key, child]) => [key, visit(child, depth + 1, input, key)])
          ]
        } else {
          throw new Error('Plugin data supports plain objects, arrays and binary attachments')
        }
        ancestors.delete(input)
        return result
      }
      const json = stringify(visit(value, 0))
      if (json.length * 2 + bytes > limit) throw new Error('Plugin data exceeds 16 MiB')
      return { json, buffers, strings }
    },
    decode({ json, buffers, strings }, references = []) {
      function generationFor(table: readonly string[]): number {
        let generation = generations.get(table)
        if (generation === undefined) {
          generation = ++nextGeneration
          generations.set(table, generation)
        }
        return generation
      }
      function remember(result: object, children: [string | number, unknown][]): void {
        let slots: Map<string | number, { generation: number; index: number }> | undefined
        for (const [key, child] of children) {
          if (isArray(child) && (child[0] === 'string' || child[0] === 'reference')) {
            slots ??= new Map()
            slots.set(key, {
              generation: generationFor(child[0] === 'string' ? strings : references),
              index: child[1]
            })
          }
        }
        if (slots) fields.set(result, slots)
      }
      const wireBytes =
        json.length * 2 +
        buffers.reduce((size, buffer) => size + buffer.byteLength, 0) +
        strings.reduce((size, text) => size + text.length * 2, 0)
      if (wireBytes > limit) {
        throw new Error('Plugin data exceeds 16 MiB')
      }
      let bytes = json.length * 2
      function charge(size: number): void {
        bytes += size
        if (bytes > limit) throw new Error('Plugin data exceeds 16 MiB')
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
          case 'string':
          case 'reference': {
            const table = tag === 'string' ? strings : references
            if (!Number.isInteger(data) || data < 0 || data >= table.length)
              throw new Error('Invalid plugin text reference')
            const text = table[data]
            if (typeof text !== 'string') throw new Error('Invalid plugin text reference')
            // Count every use, even if one immutable string is shared many times.
            charge(text.length * 2)
            return text
          }
          case 'bytes':
          case 'buffer': {
            const buffer = buffers[data]
            if (!(buffer instanceof Binary)) throw new Error('Invalid plugin binary attachment')
            charge(buffer.byteLength)
            return tag === 'bytes' ? new Bytes(buffer) : buffer
          }
          case 'array': {
            const result = data.map((child: unknown) => visit(child, depth + 1))
            if (rememberInputFields && (strings.length || references.length)) {
              remember(
                result,
                data.map((child: unknown, index: number) => [index, child])
              )
            }
            return result
          }
          case 'object': {
            const result = fromEntries(
              data.map(([key, child]: [string, unknown]) => [key, visit(child, depth + 1)])
            )
            if (rememberInputFields && (strings.length || references.length)) remember(result, data)
            return result
          }
          default:
            throw new Error('Invalid plugin data encoding')
        }
      }
      return visit(parse(json), 0)
    }
  }
}
