import type { QuickJSDeferredPromise, QuickJSHandle, QuickJSWASMModule } from 'quickjs-emscripten'
import { createPluginCodec, type PluginPacket } from './pluginCodec.ts'
import { createPluginGuest } from './pluginGuest.ts'
import type { PluginDescriptor, PluginHooks, PluginSource } from './pluginTypes.ts'

interface QuickJsPlugin {
  descriptor: PluginDescriptor
  invoke(
    hook: keyof PluginHooks,
    event: unknown,
    deadline: number,
    callState: (input: unknown) => Promise<unknown>
  ): Promise<unknown>
  dispose(): void
}

interface Invocation {
  active: boolean
  calls: number
  bytes: number
  pending: Set<QuickJSDeferredPromise>
}

const PAYLOAD_LIMIT = 16 * 1024 * 1024
const TEXT_CACHE_LIMIT = 4 * 1024 * 1024

export async function createQuickJsPlugin(
  quickjs: QuickJSWASMModule,
  source: PluginSource,
  hookNames: string[],
  initializationDeadline: number
): Promise<QuickJsPlugin> {
  const runtime = quickjs.newRuntime()
  runtime.setMemoryLimit(128 * 1024 * 1024)
  runtime.setMaxStackSize(1024 * 1024)
  let deadline = initializationDeadline
  runtime.setInterruptHandler(() => Date.now() >= deadline)
  runtime.setModuleLoader(() => {
    throw new Error('Plugin imports are not supported in QuickJS')
  })
  const vm = runtime.newContext()
  const codec = createPluginCodec()
  const textCache = new Map<string, { text: string; handle: QuickJSHandle }>()
  let cachedBytes = 0
  let guest: QuickJSHandle | undefined
  let definition: QuickJSHandle | undefined
  let wake: (() => void) | undefined

  function textToVm(text: string): QuickJSHandle {
    const cached = textCache.get(text)
    if (cached) {
      // Keep the original host string instead of retaining a fresh IPC copy on every hit.
      textCache.delete(cached.text)
      textCache.set(cached.text, cached)
      return cached.handle.dup()
    }
    const handle = vm.newString(text)
    const size = text.length * 2
    if (size <= TEXT_CACHE_LIMIT) {
      while (cachedBytes + size > TEXT_CACHE_LIMIT) {
        const [oldText, oldEntry] = textCache.entries().next().value!
        textCache.delete(oldText)
        cachedBytes -= oldText.length * 2
        oldEntry.handle.dispose()
      }
      textCache.set(text, { text, handle: handle.dup() })
      cachedBytes += size
    }
    return handle
  }

  async function settle(handle: QuickJSHandle, invocation?: Invocation): Promise<QuickJSHandle> {
    while (true) {
      if (Date.now() >= deadline) throw new Error('Plugin execution timed out')
      const jobs = runtime.executePendingJobs(100)
      if (jobs.error) vm.unwrapResult(jobs)
      const state = vm.getPromiseState(handle)
      if (state.type === 'rejected') return vm.unwrapResult(state)
      if (state.type === 'fulfilled') {
        if (!runtime.hasPendingJob() && !invocation?.pending.size) {
          return state.notAPromise ? state.value.dup() : state.value
        }
        if (!state.notAPromise) state.value.dispose()
      }
      if (runtime.hasPendingJob()) {
        await new Promise<void>((resolve) => setImmediate(resolve))
      } else {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(
            () => {
              wake = undefined
              resolve()
            },
            Math.max(1, deadline - Date.now())
          )
          wake = () => {
            clearTimeout(timer)
            wake = undefined
            resolve()
          }
        })
      }
    }
  }

  function packetToVm(packet: PluginPacket): QuickJSHandle {
    const object = vm.newObject()
    try {
      const json = vm.newString(packet.json)
      try {
        vm.setProp(object, 'json', json)
      } finally {
        json.dispose()
      }
      const buffers = vm.newArray()
      try {
        for (const [index, buffer] of packet.buffers.entries()) {
          const handle = vm.newArrayBuffer(buffer)
          try {
            vm.setProp(buffers, index, handle)
          } finally {
            handle.dispose()
          }
        }
        vm.setProp(object, 'buffers', buffers)
      } finally {
        buffers.dispose()
      }
      const strings = vm.newArray()
      try {
        for (const [index, text] of packet.strings.entries()) {
          const handle = textToVm(text)
          try {
            vm.setProp(strings, index, handle)
          } finally {
            handle.dispose()
          }
        }
        vm.setProp(object, 'strings', strings)
      } finally {
        strings.dispose()
      }
      return object
    } catch (error) {
      object.dispose()
      throw error
    }
  }

  function packetFromVm(packet: QuickJSHandle): PluginPacket {
    const json = vm.getProp(packet, 'json').consume((handle) => vm.getString(handle))
    let bytes = json.length * 2
    if (bytes > PAYLOAD_LIMIT) throw new Error('Plugin data exceeds 16 MiB')
    const array = vm.getProp(packet, 'buffers')
    try {
      const length = vm.getProp(array, 'length').consume((handle) => vm.getNumber(handle))
      if (!Number.isInteger(length) || length < 0 || length > PAYLOAD_LIMIT) {
        throw new Error('Invalid plugin binary attachments')
      }
      const buffers: ArrayBuffer[] = []
      for (let index = 0; index < length; index++) {
        const handle = vm.getProp(array, index)
        try {
          const buffer = vm.getArrayBuffer(handle)
          try {
            bytes += buffer.value.byteLength
            if (bytes > PAYLOAD_LIMIT) throw new Error('Plugin data exceeds 16 MiB')
            buffers.push(buffer.value.slice().buffer)
          } finally {
            buffer.dispose()
          }
        } finally {
          handle.dispose()
        }
      }
      const stringsHandle = vm.getProp(packet, 'strings')
      const strings: string[] = []
      try {
        const count = vm.getProp(stringsHandle, 'length').consume((handle) => vm.getNumber(handle))
        if (!Number.isInteger(count) || count < 0 || count > PAYLOAD_LIMIT)
          throw new Error('Invalid plugin text attachments')
        for (let index = 0; index < count; index++) {
          const handle = vm.getProp(stringsHandle, index)
          try {
            if (vm.typeof(handle) !== 'string') throw new Error('Invalid plugin text attachment')
            const text = vm.getString(handle)
            bytes += text.length * 2
            if (bytes > PAYLOAD_LIMIT) throw new Error('Plugin data exceeds 16 MiB')
            strings.push(text)
          } finally {
            handle.dispose()
          }
        }
      } finally {
        stringsHandle.dispose()
      }
      return { json, buffers, strings }
    } finally {
      array.dispose()
    }
  }

  function stateBridge(
    invocation: Invocation,
    callState: (input: unknown) => Promise<unknown>
  ): QuickJSHandle {
    return vm.newFunction('state', (jsonHandle) => {
      if (!invocation.active)
        return { error: vm.newError('State is only available during its active hook') }
      if (++invocation.calls > 100)
        return { error: vm.newError('Plugin hook exceeds 100 state calls') }
      const json = vm.getString(jsonHandle)
      const bytes = Buffer.byteLength(json)
      if (invocation.bytes + bytes > PAYLOAD_LIMIT) {
        return { error: vm.newError('Plugin state request exceeds its payload limit') }
      }
      const input = codec.decode({ json, buffers: [], strings: [] })
      const deferred = vm.newPromise()
      invocation.pending.add(deferred)
      invocation.bytes += bytes
      void (async () => {
        try {
          const value = await callState(input)
          if (!invocation.active) return
          const result = vm.newString(JSON.stringify(value))
          try {
            deferred.resolve(result)
          } finally {
            result.dispose()
          }
        } catch (error) {
          if (!invocation.active) return
          const result = vm.newError(error instanceof Error ? error.message : String(error))
          try {
            deferred.reject(result)
          } finally {
            result.dispose()
          }
        } finally {
          if (invocation.pending.delete(deferred)) deferred.dispose()
          invocation.bytes -= bytes
          wake?.()
        }
      })()
      return deferred.handle
    })
  }

  function dispose(): void {
    for (const { handle } of textCache.values()) handle.dispose()
    textCache.clear()
    definition?.dispose()
    guest?.dispose()
    vm.dispose()
    runtime.dispose()
  }

  try {
    guest = vm.unwrapResult(
      vm.evalCode(`(${createPluginGuest.toString()})((${createPluginCodec.toString()})(true))`)
    )
    const evaluated = vm.unwrapResult(vm.evalCode(source.source, source.name, { type: 'module' }))
    try {
      const exports = await settle(evaluated)
      try {
        definition = vm.getProp(exports, 'default')
      } finally {
        exports.dispose()
      }
    } finally {
      evaluated.dispose()
    }
    const allowed = vm.newString(JSON.stringify(hookNames))
    let hooks: PluginDescriptor['hooks']
    try {
      hooks = vm
        .unwrapResult(vm.callMethod(guest, 'validate', [definition, allowed]))
        .consume((handle) => JSON.parse(vm.getString(handle)))
    } finally {
      allowed.dispose()
    }
    const guestHandle = guest
    const definitionHandle = definition
    return {
      descriptor: { name: source.name, revision: source.revision, hooks },
      async invoke(hook, event, hookDeadline, callState) {
        deadline = hookDeadline
        const invocation: Invocation = { active: true, calls: 0, bytes: 0, pending: new Set() }
        const handles: QuickJSHandle[] = []
        try {
          const hookHandle = vm.newString(hook)
          handles.push(hookHandle)
          const input = codec.encode(event)
          const packet = packetToVm(input)
          handles.push(packet)
          const bridge = stateBridge(invocation, callState)
          handles.push(bridge)
          const result = vm.unwrapResult(
            vm.callMethod(guestHandle, 'invoke', [definitionHandle, hookHandle, packet, bridge])
          )
          handles.push(result)
          const settled = await settle(result, invocation)
          handles.push(settled)
          return codec.decode(packetFromVm(settled), input.strings)
        } finally {
          invocation.active = false
          for (const deferred of invocation.pending) deferred.dispose()
          invocation.pending.clear()
          for (const handle of handles.reverse()) handle.dispose()
        }
      },
      dispose
    }
  } catch (error) {
    dispose()
    throw error
  }
}
