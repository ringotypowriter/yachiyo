import { randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo, Socket } from 'node:net'
import { TextDecoder } from 'node:util'

import type { ToolExecutionOptions } from 'ai'
import { z } from 'zod'

import { executeNestedReplTool } from './replNestedTools.ts'

const REQUEST_LIMIT_BYTES = 32 * 1024 * 1024
const RESPONSE_LIMIT_BYTES = 64 * 1024 * 1024
const toolRequestSchema = z
  .object({
    cellId: z.string().min(1),
    tool: z.string().min(1),
    input: z.unknown()
  })
  .strict()

export interface PyReplBridgeCellContext {
  cellId: string
  cwd: string
  executionOptions: ToolExecutionOptions
  resolveTool: (name: string) => unknown
  availableTools: readonly string[]
  signal: AbortSignal
}

interface ActiveCell extends PyReplBridgeCellContext {
  requests: Set<AbortController>
  allowedTools: ReadonlySet<string>
}

interface ToolRequest {
  cellId: string
  tool: string
  input: unknown
}

type ToolResponse = { ok: true; value: unknown } | { ok: false; error: string }

export interface PyReplBridgeEndpoint {
  url: string
  token: string
}

export class PyReplToolBridge {
  private readonly token = randomBytes(32).toString('hex')
  private readonly sockets = new Set<Socket>()
  private server: Server | undefined
  private endpointPromise: Promise<PyReplBridgeEndpoint> | undefined
  private activeCell: ActiveCell | undefined
  private disposed = false

  async endpoint(): Promise<PyReplBridgeEndpoint> {
    if (this.disposed) throw new Error('Python REPL tool bridge is disposed.')
    this.endpointPromise ??= this.listen()
    return await this.endpointPromise
  }

  activateCell(context: PyReplBridgeCellContext): void {
    if (this.disposed) throw new Error('Python REPL tool bridge is disposed.')
    if (this.activeCell) throw new Error('Python REPL tool bridge already has an active cell.')
    this.activeCell = {
      ...context,
      allowedTools: new Set(context.availableTools),
      requests: new Set()
    }
  }

  deactivateCell(cellId: string): void {
    const activeCell = this.activeCell
    if (!activeCell || activeCell.cellId !== cellId) return
    this.activeCell = undefined
    for (const controller of activeCell.requests) controller.abort()
    activeCell.requests.clear()
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    if (this.activeCell) this.deactivateCell(this.activeCell.cellId)

    for (const socket of this.sockets) socket.destroy()
    this.sockets.clear()

    const server = this.server
    this.server = undefined
    if (!server) return
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }

  private async listen(): Promise<PyReplBridgeEndpoint> {
    const server = createServer((request, response) => {
      void this.handleRequest(request, response)
    })
    this.server = server
    server.on('connection', (socket) => {
      this.sockets.add(socket)
      socket.unref()
      socket.once('close', () => this.sockets.delete(socket))
    })
    server.on('clientError', (_error, socket) => socket.destroy())

    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error): void => reject(error)
        server.once('error', onError)
        server.listen(0, '127.0.0.1', () => {
          server.off('error', onError)
          resolve()
        })
      })
      server.unref()
    } catch (error) {
      this.server = undefined
      throw error
    }

    if (this.disposed) {
      await new Promise<void>((resolve) => server.close(() => resolve()))
      throw new Error('Python REPL tool bridge was disposed during startup.')
    }
    const address = server.address()
    if (!address || typeof address === 'string') {
      throw new Error('Python REPL tool bridge did not expose a TCP address.')
    }
    return {
      url: `http://127.0.0.1:${(address as AddressInfo).port}/tool`,
      token: this.token
    }
  }

  private async handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      if (this.disposed) {
        writeJson(response, 503, { ok: false, error: 'Python REPL tool bridge is disposed.' })
        return
      }
      if (request.method !== 'POST' || request.url !== '/tool') {
        writeJson(response, 404, { ok: false, error: 'Not found.' })
        return
      }
      if (!this.isAuthorized(request.headers.authorization)) {
        response.setHeader('www-authenticate', 'Bearer')
        writeJson(response, 401, { ok: false, error: 'Unauthorized.' })
        return
      }
      if (!hasJsonMediaType(request.headers['content-type'])) {
        writeJson(response, 415, { ok: false, error: 'Content-Type must be application/json.' })
        return
      }

      const encoded = await readRequestBody(request)
      const input = parseToolRequest(encoded)
      const activeCell = this.activeCell
      if (!activeCell || activeCell.cellId !== input.cellId) {
        writeJson(response, 409, { ok: false, error: 'Python REPL cell is not active.' })
        return
      }
      if (!activeCell.allowedTools.has(input.tool)) {
        writeJson(response, 403, {
          ok: false,
          error: `Tool ${JSON.stringify(input.tool)} is not available.`
        })
        return
      }

      const requestController = new AbortController()
      const abortClientRequest = (): void => requestController.abort()
      request.once('aborted', abortClientRequest)
      response.once('close', abortClientRequest)
      activeCell.requests.add(requestController)
      const signal = AbortSignal.any([activeCell.signal, requestController.signal])
      try {
        const value = await executeNestedReplTool({
          replName: 'pyRepl',
          toolName: input.tool,
          input: input.input,
          cwd: activeCell.cwd,
          resolveTool: activeCell.resolveTool,
          executionOptions: activeCell.executionOptions,
          signal
        })
        if (!isStrictJsonTree(value)) {
          throw new Error('Tool output is not a strict JSON value.')
        }
        writeToolResponse(response, { ok: true, value })
      } catch (error) {
        writeToolResponse(response, {
          ok: false,
          error: error instanceof Error ? error.message : String(error)
        })
      } finally {
        request.off('aborted', abortClientRequest)
        response.off('close', abortClientRequest)
        activeCell.requests.delete(requestController)
      }
    } catch (error) {
      const status = error instanceof RequestBodyTooLargeError ? 413 : 400
      writeJson(response, status, {
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      })
    }
  }

  private isAuthorized(header: string | undefined): boolean {
    if (!header?.startsWith('Bearer ')) return false
    const supplied = Buffer.from(header.slice('Bearer '.length), 'utf8')
    const expected = Buffer.from(this.token, 'utf8')
    return supplied.length === expected.length && timingSafeEqual(supplied, expected)
  }
}

class RequestBodyTooLargeError extends Error {}

async function readRequestBody(request: IncomingMessage): Promise<Buffer> {
  const declaredLength = request.headers['content-length']
  if (declaredLength !== undefined) {
    if (!/^(0|[1-9]\d*)$/.test(declaredLength)) {
      throw new Error('Invalid Content-Length header.')
    }
    const parsedLength = Number(declaredLength)
    if (!Number.isSafeInteger(parsedLength)) {
      throw new Error('Invalid Content-Length header.')
    }
    if (parsedLength > REQUEST_LIMIT_BYTES) {
      throw new RequestBodyTooLargeError('Tool request exceeds the 32 MiB limit.')
    }
  }

  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > REQUEST_LIMIT_BYTES) {
      throw new RequestBodyTooLargeError('Tool request exceeds the 32 MiB limit.')
    }
    chunks.push(buffer)
  }
  return Buffer.concat(chunks, size)
}

function parseToolRequest(encoded: Buffer): ToolRequest {
  let value: unknown
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(encoded)) as unknown
  } catch {
    throw new Error('Tool request body is not valid UTF-8 JSON.')
  }
  const parsed = toolRequestSchema.safeParse(value)
  if (!parsed.success) {
    throw new Error('Tool request must contain exactly non-empty cellId, tool, and input.')
  }
  if (!isStrictJsonTree(parsed.data.input)) {
    throw new Error('Tool request input must be a strict JSON value.')
  }
  return parsed.data
}

function writeToolResponse(response: ServerResponse, payload: ToolResponse): void {
  const body = stringifyJson(payload)
  if (Buffer.byteLength(body, 'utf8') > RESPONSE_LIMIT_BYTES) {
    writeJson(response, 500, { ok: false, error: 'Tool response exceeds the 64 MiB limit.' })
    return
  }
  writeEncodedJson(response, 200, body)
}

function writeJson(response: ServerResponse, status: number, payload: ToolResponse): void {
  writeEncodedJson(response, status, stringifyJson(payload))
}

function writeEncodedJson(response: ServerResponse, status: number, body: string): void {
  if (response.headersSent || response.destroyed) return
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body, 'utf8'),
    'cache-control': 'no-store'
  })
  response.end(body)
}

function stringifyJson(value: unknown): string {
  const body = JSON.stringify(value)
  if (body === undefined) throw new Error('Unable to encode JSON response.')
  return body
}

function hasJsonMediaType(value: string | undefined): boolean {
  return value?.split(';', 1)[0]?.trim().toLowerCase() === 'application/json'
}

type JsonTraversal = { action: 'enter'; value: unknown } | { action: 'leave'; value: object }

export function isStrictJsonTree(value: unknown): boolean {
  const ancestors = new WeakSet<object>()
  const pending: JsonTraversal[] = [{ action: 'enter', value }]
  while (pending.length > 0) {
    const item = pending.pop()!
    if (item.action === 'leave') {
      ancestors.delete(item.value)
      continue
    }

    const current = item.value
    if (current === null || typeof current === 'string' || typeof current === 'boolean') {
      continue
    }
    if (typeof current === 'number') {
      if (
        !Number.isFinite(current) ||
        (Number.isInteger(current) && !Number.isSafeInteger(current))
      ) {
        return false
      }
      continue
    }
    if (typeof current !== 'object' || ancestors.has(current)) return false

    if (Array.isArray(current)) {
      if (Object.getPrototypeOf(current) !== Array.prototype) return false
      const names = Object.getOwnPropertyNames(current)
      if (
        Object.getOwnPropertySymbols(current).length > 0 ||
        names.length !== current.length + 1 ||
        names[names.length - 1] !== 'length'
      ) {
        return false
      }
      for (let index = 0; index < current.length; index += 1) {
        if (names[index] !== String(index)) return false
      }
      ancestors.add(current)
      pending.push({ action: 'leave', value: current })
      for (let index = current.length - 1; index >= 0; index -= 1) {
        pending.push({ action: 'enter', value: current[index] })
      }
      continue
    }

    const prototype = Object.getPrototypeOf(current)
    if (prototype !== Object.prototype && prototype !== null) return false
    const descriptors = Object.getOwnPropertyDescriptors(current)
    if (Object.getOwnPropertySymbols(current).length > 0) return false
    const children: unknown[] = []
    for (const descriptor of Object.values(descriptors)) {
      if (!descriptor.enumerable || !('value' in descriptor)) return false
      children.push(descriptor.value)
    }
    ancestors.add(current)
    pending.push({ action: 'leave', value: current })
    for (let index = children.length - 1; index >= 0; index -= 1) {
      pending.push({ action: 'enter', value: children[index] })
    }
  }
  return true
}
